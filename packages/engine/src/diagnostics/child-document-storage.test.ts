import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChildStorageSelectionReport } from '../child-tasks/storage-binding.js';
import { createChildDocumentReadFrame } from '../storage/child-document-reader.js';
import type { InputDocumentIndexReport } from '../storage/input-document-index.js';
import { inspectChildDocumentStorage,validateChildDocumentStorageRequest,DEFAULT_CHILD_DOCUMENT_STORAGE_LIMITS } from './child-document-storage.js';

function index(complete=true):InputDocumentIndexReport{return{scope:'primary-database-only',observedAt:new Date().toISOString(),complete,totalDocuments:1,sampledDocuments:1,invalidDocuments:complete?0:1,omittedDocuments:0,invalidReferences:0,omittedReferences:complete?0:null,sampledJsonBytes:100,documents:[],refs:[],documentIds:[],declaredBytes:complete?42:0,limits:{maxDocuments:64,maxRefs:2048,maxJsonBytes:4_194_304},reasons:complete?[]:['invalid-owner'],coverage:{source:'session_documents.input_documents',ownerValidation:'joined-session-workspace-and-stored-payload',bytes:'UTF-8 sampled JSON and declared unique reference bytes',sql:'bounded metadata/payload rows; document count may scan primary headers',childDatabases:'not-read',childBlobs:'not-read',filesystem:'not-read',physicalReadBytes:null}};}
function selection():ChildStorageSelectionReport{return{scope:'managed-child-storage',mode:'source',complete:true,sessionId:'session',sourceRunId:'run',selections:[],selectedMetadataBytes:0,physicalIO:null};}
const code=(expected:string)=>(error:unknown)=>error instanceof Error&&'code'in error&&error.code===expected;

test('public request clones exact task selectors and validates all caps without invoking traps',()=>{
  const taskId='child_'+'a'.repeat(32),source={sessionId:'session',sourceRunId:'run',taskIds:[taskId],limits:{maxMetadataBytes:1000}},validated=validateChildDocumentStorageRequest(source);
  source.taskIds[0]='changed';source.limits.maxMetadataBytes=1;assert.deepEqual(validated.taskIds,[taskId]);assert.equal(validated.limits.maxMetadataBytes,1000);assert.ok(Object.isFrozen(validated.taskIds));
  let traps=0;const accessor={sessionId:'session',sourceRunId:'run',taskIds:[]};Object.defineProperty(accessor,'limits',{enumerable:true,get(){traps++;throw new Error('private');}});
  const proxy=new Proxy(accessor,{ownKeys(){traps++;throw new Error('private');}});
  const proxyIds=new Proxy([],{get(){traps++;throw new Error('private');}});
  for(const value of [accessor,proxy,{sessionId:'session',sourceRunId:'run',taskIds:proxyIds}])assert.throws(()=>validateChildDocumentStorageRequest(value),code('INVALID_CHILD_DOCUMENT_STORAGE_OPTIONS'));
  assert.equal(traps,0);
});

test('sparse/selectors with accessors, extra fields, duplicate IDs and caps above hard ceilings are rejected',()=>{
  const taskId='child_'+'a'.repeat(32),base={sessionId:'session',sourceRunId:'run',taskIds:[]},sparse=new Array(1),ids=[taskId];let gets=0;Object.defineProperty(ids,'0',{get(){gets++;return taskId;},enumerable:true});
  for(const value of [{...base,taskIds:sparse},{...base,taskIds:ids},{...base,taskIds:[taskId,taskId]},{...base,path:'/arbitrary'},{...base,limits:{maxChildren:33}},{...base,limits:{maxReportBytes:32769}},{...base,limits:{maxMetadataBytes:8388609}},{...base,limits:{maxRows:8193}},{...base,limits:{maxRefs:2049}},{...base,limits:{maxMirrorBytes:268435457}},{...base,limits:{maxDatabaseBytes:33554433}},{...base,limits:{maxDurationMs:2001}}])assert.throws(()=>validateChildDocumentStorageRequest(value),code('INVALID_CHILD_DOCUMENT_STORAGE_OPTIONS'));
  assert.equal(gets,0);
});

test('root-only diagnostic is an index observation and never adds filesystem bytes',async()=>{
  const rootIndex=index(),frame=createChildDocumentReadFrame();frame.chargeIndex(rootIndex);
  const report=await inspectChildDocumentStorage({selection:selection(),rootIndex,frame,limits:DEFAULT_CHILD_DOCUMENT_STORAGE_LIMITS});
  assert.equal(report.complete,true);assert.equal(report.rootIndex.declaredBytes,42);assert.equal(report.declaredReferenceBytes.sum,42);assert.equal(report.declaredReferenceBytes.children,0);
  assert.equal(report.declaredReferenceBytes.physicalFileBytes,null);assert.equal(report.coverage.parentChildBytes,'not-added');assert.equal(report.coverage.blobIntegrity,'not-verified');assert.equal(report.coverage.executionAuthority,'not-granted');assert.equal(report.stats.selectedRows,3);
});

test('missing or incomplete root index yields unknown totals instead of a sampled zero',async()=>{
  for(const rootIndex of [undefined,index(false)]){
    const frame=createChildDocumentReadFrame();if(rootIndex)frame.chargeIndex(rootIndex);
    const report=await inspectChildDocumentStorage({selection:selection(),rootIndex,frame,limits:DEFAULT_CHILD_DOCUMENT_STORAGE_LIMITS});
    assert.equal(report.complete,false);assert.equal(report.rootIndex.declaredBytes,null);assert.equal(report.declaredReferenceBytes.root,null);assert.equal(report.declaredReferenceBytes.sum,null);
    assert.ok(report.reasons.includes(rootIndex?'root-index-incomplete':'root-index-budget-limit'));
  }
});

test('unchecked child stays unknown with no source/mirror read and separate known subtotal',async()=>{
  const selected=selection();selected.complete=false;selected.selections=[{taskId:'child_'+'b'.repeat(32),status:'active',reasons:['CHILD_STORAGE_ACTIVE']}];
  const report=await inspectChildDocumentStorage({selection:selected,rootIndex:index(),frame:createChildDocumentReadFrame(),limits:DEFAULT_CHILD_DOCUMENT_STORAGE_LIMITS});
  assert.equal(report.complete,false);assert.equal(report.children[0]!.status,'unchecked');assert.equal(report.declaredReferenceBytes.children,null);assert.equal(report.declaredReferenceBytes.observedChildSubtotal,0);assert.equal(report.declaredReferenceBytes.sum,null);assert.equal(report.stats.rawMirrorBytes,0);
});

test('combined report byte cap truncates child details while retaining explicit omitted and unchecked scope',async()=>{
  const selected=selection();selected.complete=false;selected.selections=Array.from({length:32},(_,i)=>({taskId:'child_'+i.toString(16).padStart(32,'0'),status:'legacy' as const,reasons:['a'.repeat(200)]}));
  const report=await inspectChildDocumentStorage({selection:selected,rootIndex:index(),frame:createChildDocumentReadFrame(),limits:{...DEFAULT_CHILD_DOCUMENT_STORAGE_LIMITS,maxChildren:32,maxReportBytes:4096}});
  assert.ok(Buffer.byteLength(JSON.stringify(report))<=4096);assert.ok(report.reportsOmitted>0);assert.equal(report.uncheckedChildren,32);assert.equal(report.complete,false);assert.equal(report.declaredReferenceBytes.sum,null);assert.ok(report.reasons.includes('report-byte-limit'));
});

test('cooperative cancel and time exhaustion remain explicit partial scope before any child opens',async()=>{
  const selected=selection();selected.complete=false;selected.selections=[{taskId:'child_'+'b'.repeat(32),status:'legacy',reasons:['CHILD_STORAGE_BINDING_MISSING']}];
  const controller=new AbortController(),frame=createChildDocumentReadFrame({signal:controller.signal});controller.abort();
  const cancelled=await inspectChildDocumentStorage({selection:selected,rootIndex:index(),frame,limits:DEFAULT_CHILD_DOCUMENT_STORAGE_LIMITS});assert.equal(cancelled.complete,false);assert.equal(cancelled.stats.openedChildren,0);assert.ok(cancelled.children[0]!.reasons.includes('CHILD_DOCUMENT_STORAGE_ABORTED'));
  const timed=createChildDocumentReadFrame({limits:{maxDurationMs:1}});await new Promise(resolve=>setTimeout(resolve,5));
  const timeout=await inspectChildDocumentStorage({selection:selected,rootIndex:index(),frame:timed,limits:{...DEFAULT_CHILD_DOCUMENT_STORAGE_LIMITS,maxDurationMs:1}});assert.equal(timeout.complete,false);assert.equal(timeout.stats.openedChildren,0);assert.equal(timeout.stats.exhaustedReason,'CHILD_DOCUMENT_STORAGE_TIME_LIMIT');
});
