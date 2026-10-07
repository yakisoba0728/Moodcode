import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { attachment, attachments, cancelled, DEFAULT_DOCUMENT_LIMITS, digest, documentLimits, validateDocumentBytes } from './validation.js';
const code=(expected:string)=>(error:unknown)=>error instanceof EngineError && error.code===expected;
const ref=()=>({id:'doc_'+'1'.repeat(32),kind:'document' as const,mimeType:'application/pdf' as const,bytes:9,sha256:digest(Buffer.from('%PDF-1.7\n'))});
test('PDF sniff accepts only supported header versions and leaves structure opaque',()=>{
  for(const header of ['%PDF-1.0\n','%PDF-1.7\r','%PDF-2.0\n'])validateDocumentBytes(Buffer.from(header),'application/pdf');
  validateDocumentBytes(Buffer.from('%PDF-1.7\nnot a parsed PDF'),'application/pdf');
  for(const header of ['%PDF-1.8\n','%PDF-2.1\n','%PDF-1.7','prefix%PDF-1.7\n','%PDF-1.7x','%PDF-9.9\n'])assert.throws(()=>validateDocumentBytes(Buffer.from(header),'application/pdf'),code('DOCUMENT_INVALID_FORMAT'));
  assert.throws(()=>validateDocumentBytes(Buffer.from('%PDF-1.7\n'),'text/plain' as 'application/pdf'),code('DOCUMENT_MIME_MISMATCH'));
  assert.throws(()=>validateDocumentBytes(Buffer.alloc(524289),'application/pdf'),code('DOCUMENT_LIMIT_EXCEEDED'));
});
test('canonical document refs reject filenames, paths, bytes, traversal and malformed identity',()=>{
  assert.deepEqual(attachment(ref()),ref());
  for(const value of [{...ref(),filename:'private.pdf'},{...ref(),data:'private'},{...ref(),path:'/private'},{...ref(),id:'../private'},{...ref(),bytes:524289},{...ref(),kind:'image'},{...ref(),mimeType:'application/x-pdf'},{...ref(),sha256:'A'.repeat(64)}])assert.throws(()=>attachment(value),code('DOCUMENT_INVALID_REFERENCE'));
  assert.deepEqual(attachments([ref()]),[ref()]);assert.throws(()=>attachments([ref(),ref()]),code('DOCUMENT_LIMIT_EXCEEDED'));
});
test('plain data checks reject accessors, proxies and sparse refs before running traps',()=>{
  let traps=0;const proxy=new Proxy(ref(),{get(){traps++;throw new Error('trap');},getPrototypeOf(){traps++;throw new Error('trap');}});
  assert.throws(()=>attachment(proxy),code('DOCUMENT_INVALID_REFERENCE'));
  assert.throws(()=>attachments(new Proxy([ref()],{get(){traps++;throw new Error('trap');}})),code('DOCUMENT_INVALID_REFERENCE'));
  const accessor={...ref()};Object.defineProperty(accessor,'id',{enumerable:true,get(){traps++;throw new Error('trap');}});
  assert.throws(()=>attachment(accessor),code('DOCUMENT_INVALID_REFERENCE'));const sparse=new Array(1);assert.throws(()=>attachments(sparse),code('DOCUMENT_INVALID_REFERENCE'));assert.equal(traps,0);
  const decorated=[ref()];Object.defineProperty(decorated,'toJSON',{value:()=>[]});assert.throws(()=>attachments(decorated),code('DOCUMENT_INVALID_REFERENCE'));
});
test('limits may tighten only and configuration/signal traps never run',()=>{
  assert.equal(documentLimits({maxDocumentBytes:10}).maxDocumentBytes,10);assert.equal(Object.isFrozen(DEFAULT_DOCUMENT_LIMITS),true);
  for(const value of [{maxDocumentBytes:524289},{maxInputDocuments:2},{maxSessionBytes:0},{extra:1}])assert.throws(()=>documentLimits(value),code('DOCUMENT_INVALID_CONFIG'));
  let traps=0;const proxy=new Proxy({},{get(){traps++;throw new Error('trap');},ownKeys(){traps++;throw new Error('trap');}});
  assert.throws(()=>documentLimits(proxy),code('DOCUMENT_INVALID_CONFIG'));assert.throws(()=>cancelled(proxy as AbortSignal),code('DOCUMENT_INVALID_CONFIG'));assert.equal(traps,0);
  const controller=new AbortController();controller.abort('private');assert.throws(()=>cancelled(controller.signal),code('DOCUMENT_CANCELLED'));
});
