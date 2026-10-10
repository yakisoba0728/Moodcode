import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { PhysicalPatchProducer } from './physical.js';

const digest = (content: string) => createHash('sha256').update(content).digest('hex');
const change = (relative: string, before: string | null, after: string | null) => ({ path: relative, expectedHash: before === null ? null : digest(before), content: after });
const hasCode = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'moodcode-physical-patch-'))), physical = new PhysicalPatchProducer();
  const stat = await fs.lstat(root), binding = { workspaceId:'workspace',root,rootDevice:String(stat.dev),rootInode:String(stat.ino) }, controller = new AbortController();
  return { root,physical,binding,controller,cleanup:async()=>{ await physical.close(); await fs.rm(root,{recursive:true,force:true}); } };
}
function deferred() { let resolve!:()=>void; const promise = new Promise<void>(yes=>{resolve=yes;}); return { promise,resolve }; }

test('neutral originals capture actual images and produce authenticated observed create/update/delete without Run owners',async()=>{
  const f=await fixture();try{
    await fs.writeFile(path.join(f.root,'a'),'old');await fs.writeFile(path.join(f.root,'b'),'delete');
    const original=await f.physical.prepare(f.binding,[change('a','old','new'),change('b','delete',null),change('parent/c',null,'created')],f.controller.signal);
    assert.equal(await fs.readFile(path.join(f.root,'a'),'utf8'),'old');
    assert.match(f.physical.read(original).physicalPinsSha256,/^[a-f0-9]{64}$/u);
    assert.throws(()=>f.physical.read({...original}),hasCode('INVALID_PREPARED_PATCH'));
    let dispatched=0;const result=await f.physical.apply(original,{signal:f.controller.signal,beforeEffect:async()=>{dispatched++;assert.equal(await fs.readFile(path.join(f.root,'a'),'utf8'),'old');}});
    const observation=f.physical.readResult(result);assert.equal(dispatched,1);assert.equal(observation.state,'applied');assert.equal(observation.cleanupConfirmed,true);
    assert.deepEqual(observation.files.map(file=>[file.path,file.before,file.after,file.observationComplete]),[['a','old','new',true],['b','delete',null,true],['parent/c',null,'created',true]]);
    assert.equal(observation.createdParentCount,1);assert.deepEqual(observation.createdParents,['parent']);
    assert.throws(()=>f.physical.readResult({...result}),hasCode('INVALID_PATCH_RESULT'));
    Object.assign(observation.files[0]!,{after:'forged'});assert.equal(f.physical.readResult(result).files[0]!.after,'new');
    await assert.rejects(f.physical.apply(original,{signal:f.controller.signal,beforeEffect:async()=>{}}),hasCode('INVALID_PREPARED_PATCH'));
  }finally{await f.cleanup();}
});

test('all targets are revalidated after awaited dispatch callback before any target effect',async()=>{
  const f=await fixture();try{
    await fs.writeFile(path.join(f.root,'a'),'old');await fs.writeFile(path.join(f.root,'b'),'second');
    const original=await f.physical.prepare(f.binding,[change('a','old','new'),change('b','second','new-second')],f.controller.signal);
    const result=await f.physical.apply(original,{signal:f.controller.signal,beforeEffect:async()=>{await fs.writeFile(path.join(f.root,'b'),'external');}}),observation=f.physical.readResult(result);
    assert.equal(observation.state,'partial');assert.equal(observation.attemptedFileCount,0);assert.deepEqual(observation.files.map(file=>[file.path,file.attempted,file.mayHaveChanged,file.after]),[['a',false,false,'old'],['b',false,false,'external']]);assert.equal(observation.cleanupConfirmed,true);
    assert.equal(await fs.readFile(path.join(f.root,'a'),'utf8'),'old');assert.equal(await fs.readFile(path.join(f.root,'b'),'utf8'),'external');
  }finally{await f.cleanup();}
});

test('same-content replacement of a physical parent invalidates the original capture',async()=>{
  const f=await fixture();try{
    await fs.mkdir(path.join(f.root,'parent'));await fs.writeFile(path.join(f.root,'parent/a'),'old');
    const original=await f.physical.prepare(f.binding,[change('parent/a','old','new')],f.controller.signal);
    await fs.rename(path.join(f.root,'parent'),path.join(f.root,'old-parent'));await fs.mkdir(path.join(f.root,'parent'));
    await fs.rename(path.join(f.root,'old-parent/a'),path.join(f.root,'parent/a'));
    await assert.rejects(f.physical.assertFresh(original,f.controller.signal),hasCode('PATCH_APPROVAL_STALE'));
    let dispatched=0;await assert.rejects(f.physical.apply(original,{signal:f.controller.signal,beforeEffect:async()=>{dispatched++;}}),hasCode('PATCH_APPROVAL_STALE'));
    assert.equal(dispatched,0);assert.equal(await fs.readFile(path.join(f.root,'parent/a'),'utf8'),'old');
  }finally{await f.cleanup();}
});

test('cancellation after an actual write preserves the observed partial pre/postimages',async()=>{
  const f=await fixture(),open=fs.open;try{
    await fs.writeFile(path.join(f.root,'a'),'old');await fs.writeFile(path.join(f.root,'b'),'second');
    const original=await f.physical.prepare(f.binding,[change('a','old','new'),change('b','second','new-second')],f.controller.signal);
    fs.open=async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);if(String(args[0])===path.join(f.root,'a')){const write=handle.write.bind(handle);handle.write=(async(...values:unknown[])=>{const result=await (write as (...v:unknown[])=>Promise<unknown>)(...values);f.controller.abort();return result;}) as typeof handle.write;}return handle;};
    const result=await f.physical.apply(original,{signal:f.controller.signal,beforeEffect:async()=>{}}),observation=f.physical.readResult(result);
    assert.equal(observation.state,'partial');assert.equal(observation.cleanupConfirmed,true);assert.equal(observation.files[0]!.before,'old');assert.equal(observation.files[0]!.after,'new');
    assert.equal(await fs.readFile(path.join(f.root,'b'),'utf8'),'second');
  }finally{fs.open=open;await f.cleanup();}
});

test('close joins the original held descriptor read and close before releasing a cancelled capture',async()=>{
  const f=await fixture(),open=fs.open,entered=deferred(),continueRead=deferred(),closeEntered=deferred(),continueClose=deferred();let settled=false;
  try{
    await fs.writeFile(path.join(f.root,'a'),'old');let patched=false;
    fs.open=async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);if(!patched&&String(args[0])===path.join(f.root,'a')){patched=true;const read=handle.read.bind(handle),close=handle.close.bind(handle);handle.read=(async(...values:unknown[])=>{entered.resolve();await continueRead.promise;return (read as (...v:unknown[])=>Promise<unknown>)(...values);}) as typeof handle.read;handle.close=async()=>{closeEntered.resolve();await continueClose.promise;return close();};}return handle;};
    const capture=f.physical.prepare(f.binding,[change('a','old','new')],f.controller.signal);void capture.catch(()=>{});await entered.promise;
    const closed=f.physical.close().then(()=>{settled=true;});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(settled,false);
    continueRead.resolve();await closeEntered.promise;await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(settled,false);
    continueClose.resolve();await closed;await assert.rejects(capture,hasCode('CANCELLED'));assert.equal(await fs.readFile(path.join(f.root,'a'),'utf8'),'old');
  }finally{continueRead.resolve();continueClose.resolve();fs.open=open;await f.cleanup();}
});

test('hostile change arrays/getters are rejected without invoking user callbacks',async()=>{
  const f=await fixture();try{
    let traps=0;const proxy=new Proxy([change('a',null,'new')],{get(target,key,receiver){traps++;return Reflect.get(target,key,receiver);}});
    await assert.rejects(f.physical.prepare(f.binding,proxy,f.controller.signal),hasCode('INVALID_PATCH_INPUT'));assert.equal(traps,0);
    const getter={get path(){traps++;return 'a';},expectedHash:null,content:'new'};
    await assert.rejects(f.physical.prepare(f.binding,[getter],f.controller.signal),hasCode('INVALID_PATCH_INPUT'));assert.equal(traps,0);
    assert.deepEqual(await fs.readdir(f.root),[]);
  }finally{await f.cleanup();}
});

test('patch paths reject Windows aliases of Git metadata and dependencies',async()=>{
  const f=await fixture();try{
    for(const relative of ['.git./hooks/pre-commit','.git /hooks/pre-commit','GIT~1/hooks/pre-commit','NODE_M~1/pkg/index.js','src/trailing.'])await assert.rejects(f.physical.prepare(f.binding,[change(relative,null,'new')],f.controller.signal),hasCode('INVALID_PATCH_PATH'));
    assert.deepEqual(await fs.readdir(f.root),[]);
  }finally{await f.cleanup();}
});

test('patch parents that physically resolve into dependencies are rejected before any effect',async t=>{
  const f=await fixture();try{
    await fs.mkdir(path.join(f.root,'node_modules','pkg'),{recursive:true});await fs.writeFile(path.join(f.root,'node_modules','pkg','index.js'),'old');
    const alias='node_module\u017f';
    if(!await fs.lstat(path.join(f.root,alias)).then(()=>true,()=>false)){t.skip('volume does not fold this name onto node_modules');return;}
    await assert.rejects(f.physical.prepare(f.binding,[change(`${alias}/pkg/index.js`,'old','new')],f.controller.signal),hasCode('UNSAFE_PATCH_PATH'));
    await assert.rejects(f.physical.prepare(f.binding,[change(`${alias}/hook/index.js`,null,'new')],f.controller.signal),hasCode('UNSAFE_PATCH_PATH'));
    assert.deepEqual(await fs.readdir(path.join(f.root,'node_modules')),['pkg']);assert.equal(await fs.readFile(path.join(f.root,'node_modules','pkg','index.js'),'utf8'),'old');
  }finally{await f.cleanup();}
});

test('neutral physical lane rejects an oversized whole proposal without chunking or effects',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.physical.prepare(f.binding,Array.from({length:33},(_,i)=>change('a'+i,null,'new')),f.controller.signal),hasCode('INVALID_PATCH_INPUT'));
    const one='x'.repeat(1024*1024);await fs.writeFile(path.join(f.root,'a'),one);await fs.writeFile(path.join(f.root,'b'),one);await fs.writeFile(path.join(f.root,'c'),'x');
    await assert.rejects(f.physical.prepare(f.binding,[change('a',one,one),change('b',one,one),change('c','x','x')],f.controller.signal),hasCode('PATCH_LIMIT_EXCEEDED'));
    assert.equal(await fs.readFile(path.join(f.root,'c'),'utf8'),'x');
  }finally{await f.cleanup();}
});

test('an original descriptor close failure retains cleanup uncertainty despite a readable complete postimage',async()=>{
  const f=await fixture(),open=fs.open;let injected=false;
  try{
    await fs.writeFile(path.join(f.root,'a'),'old');const original=await f.physical.prepare(f.binding,[change('a','old','new')],f.controller.signal);
    fs.open=async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);if(!injected&&String(args[0])===path.join(f.root,'a')&&Number(args[1])!==0){
      const write=handle.write.bind(handle),close=handle.close.bind(handle);let wrote=false;
      handle.write=(async(...values:unknown[])=>{wrote=true;return (write as (...v:unknown[])=>Promise<unknown>)(...values);}) as typeof handle.write;
      handle.close=async()=>{await close();if(wrote){injected=true;throw new Error('original descriptor close was not confirmed');}};
    }return handle;};
    const result=await f.physical.apply(original,{signal:f.controller.signal,beforeEffect:async()=>{}}),observed=f.physical.readResult(result);
    assert.equal(injected,true);assert.equal(observed.state,'uncertain');assert.equal(observed.cleanupConfirmed,false);assert.equal(observed.files[0]!.observationComplete,true);
    assert.equal(observed.files[0]!.after,'new');assert.equal(observed.errorCode,'PATCH_CLEANUP_UNCERTAIN');
    await assert.rejects(f.physical.close(),hasCode('PATCH_CLEANUP_UNCERTAIN'));
  }finally{fs.open=open;await fs.rm(f.root,{recursive:true,force:true});}
});
