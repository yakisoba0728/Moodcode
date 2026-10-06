import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LIMITS, EngineError, type EngineEvent, type JsonObject, type ProviderAttempt, type Run, type TurnRecord } from '@moodcode/contracts';
import { SqliteStore } from './index.js';
import { NativeSessionStorage } from './native.js';
import { ATTEMPT_CLEANUP_LIMITS, ATTEMPT_CLEANUP_SCHEMA, AttemptCleanupStorage, canonicalAttemptCleanupSha256, type AttemptCleanupIdentity, type AttemptCleanupSettlement } from './attempt-cleanup.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const hasCode=(code:string)=>(error:unknown)=>error instanceof EngineError&&error.code===code;
const config={providerId:'scripted',modelId:'local',mode:'build' as const,limits:{...DEFAULT_LIMITS}};
function fixture(t:TestContext,{context=false,largeTurnInputs=false}:{context?:boolean;largeTurnInputs?:boolean}={}) {
  const store=new SqliteStore(':memory:'),stamp=new Date().toISOString();
  const owner=store as unknown as {db:DatabaseSync;native:NativeSessionStorage;append(run:Run,type:string,payload:JsonObject):EngineEvent};
  const db=owner.db;
  // Standalone module tests also run before the parent lands its migration wiring.
  if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='attempt_cleanup'").get())db.exec(ATTEMPT_CLEANUP_SCHEMA);
  store.putWorkspace({id:'workspace',root:'/tmp/moodcode-cleanup-fixture',gitRoot:'/tmp/moodcode-cleanup-fixture',branch:null,createdAt:stamp});
  store.createSession({id:'session',workspaceId:'workspace',title:'Cleanup evidence',createdAt:stamp});
  const accepted=store.acceptInput({sessionId:'session',requestId:'goal',prompt:'Goal',config,delivery:'queue'}),run=store.promoteInput(accepted.inputId).run;
  store.commit(run.id,'run.started',{}, {run:{state:'running'}});
  if(context)store.putContextRevision({schemaVersion:2,id:'context',sessionId:'session',runId:run.id,revision:1,kind:'baseline',sourceIds:[],text:'Pinned context',sha256:hash('Pinned context'),createdAt:stamp});
  const inputIds=[accepted.inputId];
  if(largeTurnInputs) {
    // Valid historical long IDs remain compatible even though current admission generates UUIDs.
    const base=store.getInput(accepted.inputId);
    for(let index=0;index<300;index++) {
      const id=String(index).padStart(4,'0')+'x'.repeat(220),admittedSeq=10_000+index*2;
      const input={...base,id,requestId:`historical-${index}`,admittedSeq,promotedSeq:admittedSeq+1};
      db.prepare('INSERT INTO session_inputs(id,session_id,workspace_id,request_id,fingerprint,delivery,state,admitted_seq,promoted_seq,run_id,legacy_seq,bytes,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id,'session','workspace',input.requestId,hash(id),input.delivery,'promoted',admittedSeq,admittedSeq+1,run.id,1,Buffer.byteLength(JSON.stringify(input)),JSON.stringify(input));
      inputIds.push(id);
    }
  }
  const turn:TurnRecord={schemaVersion:2,id:'turn',sessionId:'session',runId:run.id,inputIds,index:0,state:'created',createdAt:stamp,...(context?{contextRevisionId:'context'}:{})};
  const attempt:ProviderAttempt={schemaVersion:2,id:'attempt',sessionId:'session',runId:run.id,turnId:'turn',index:0,providerId:config.providerId,modelId:config.modelId,state:'prepared',createdAt:stamp,...(context?{contextRevisionId:'context'}:{})};
  store.putTurn(turn);store.putAttempt(attempt);
  const cleanup=new AttemptCleanupStorage(owner.native,(run,type,payload)=>owner.append(run,type,payload));
  const identity:AttemptCleanupIdentity={attemptId:attempt.id,sessionId:attempt.sessionId,workspaceId:'workspace',runId:run.id,turnId:turn.id,providerId:attempt.providerId,modelId:attempt.modelId,
    requestProjection:'engine-turn-request-v1',requestSha256:hash(JSON.stringify({runId:run.id,turnIndex:0,modelId:attempt.modelId,messages:[],tools:[],turnId:turn.id,attemptId:attempt.id,includeMetadata:true})),requestBytes:200,createdAt:stamp,...(context?{contextRevisionId:'context'}:{})};
  function dispatch() {cleanup.create(identity);cleanup.dispatch(attempt.id);store.putAttempt({...attempt,state:'dispatched',dispatchedAt:new Date().toISOString()});}
  function transaction<T>(operation:()=>T):T {db.exec('BEGIN IMMEDIATE');try{const result=operation();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
  t.after(()=>store.close());
  return {store,db,cleanup,identity,attempt,turn,run,dispatch,transaction};
}

test('new cleanup evidence binds its exact ordinary owner and request without reconstructing legacy proof',t=>{
  const f=fixture(t,{context:true});
  assert.throws(()=>f.cleanup.get('attempt'),hasCode('ATTEMPT_CLEANUP_NOT_FOUND'));
  const prepared=f.cleanup.create(f.identity),events=f.store.readSessionEvents('session',0);
  assert.equal(prepared.state,'prepared');assert.equal(prepared.cleanupConfirmed,null);
  assert.equal(prepared.requestSha256,f.identity.requestSha256);assert.equal(prepared.contextRevisionId,'context');
  assert.deepEqual(f.cleanup.create({...f.identity}),prepared);assert.deepEqual(f.store.readSessionEvents('session',0),events);
  for(const field of ['providerId','modelId','workspaceId','runId','turnId','requestSha256','requestBytes','contextRevisionId'] as const) {
    const wrong={...f.identity,[field]:field==='requestBytes'?201:field==='requestSha256'?hash('different'):'different'};
    assert.throws(()=>f.cleanup.create(wrong as AttemptCleanupIdentity));
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM attempt_cleanup').get()?.n,1);
  assert.equal(f.store.readEvents('session',0).filter(event=>event.type==='provider.cleanup.prepared').length,1);
});

test('confirmed cleanup distinguishes actual next.done and return.done and is terminal immutable',t=>{
  for(const method of ['iterator-next-done','iterator-return-done'] as const) {
    const f=fixture(t);f.dispatch();
    const observation:AttemptCleanupSettlement={outcome:'confirmed',method,reason:method==='iterator-next-done'?'natural-done':'consumer-close'};
    const settled=f.cleanup.settle('attempt',observation),events=f.store.readSessionEvents('session',0);
    assert.equal(settled.state,'confirmed');assert.equal(settled.cleanupConfirmed,true);assert.equal(settled.method,method);
    assert.ok(settled.createdAt<=settled.dispatchedAt!&&settled.dispatchedAt!<=settled.settledAt!&&settled.settledAt===settled.updatedAt);
    assert.deepEqual(f.cleanup.settle('attempt',observation),settled);assert.deepEqual(f.store.readSessionEvents('session',0),events);
    assert.throws(()=>f.cleanup.settle('attempt',{outcome:'uncertain',method:'return-rejected',reason:'error'}),hasCode('ATTEMPT_CLEANUP_IMMUTABLE'));
    assert.equal(f.store.getAttempt('attempt').state,'dispatched','Cleanup evidence does not invent a model execution outcome');
    assert.equal(f.store.readEvents('session',0).filter(event=>event.type==='provider.cleanup.confirmed').length,1);
  }
});

test('missing/rejected/timed-out/incomplete iterators produce immutable uncertainty rather than cleanup proof',t=>{
  for(const method of ['return-missing','return-rejected','return-timeout','return-not-done','iterator-unavailable'] as const) {
    const f=fixture(t);f.dispatch();
    const observation:AttemptCleanupSettlement={outcome:'uncertain',method,reason:'error',errorCode:'CLEANUP_UNCERTAIN'};
    const settled=f.cleanup.settle('attempt',observation);
    assert.equal(settled.cleanupConfirmed,false);assert.equal(settled.state,'uncertain');assert.equal(settled.method,method);
    assert.deepEqual(f.cleanup.settle('attempt',observation),settled);
    assert.throws(()=>f.cleanup.settle('attempt',{outcome:'confirmed',method:'iterator-return-done',reason:'error'}),hasCode('ATTEMPT_CLEANUP_IMMUTABLE'));
  }
});

test('no-dispatch observation is limited to an undispatched prepared frontier',t=>{
  const f=fixture(t);f.cleanup.create(f.identity);
  const observation:AttemptCleanupSettlement={outcome:'not-dispatched',method:'no-dispatch',reason:'cancel'};
  const settled=f.cleanup.settle('attempt',observation);assert.equal(settled.cleanupConfirmed,null);assert.equal(settled.dispatchedAt,undefined);
  assert.throws(()=>f.cleanup.dispatch('attempt'),hasCode('ATTEMPT_CLEANUP_TRANSITION_INVALID'));
  const intent=fixture(t);intent.cleanup.create(intent.identity);
  intent.store.putAttempt({...intent.attempt,state:'dispatched',dispatchedAt:new Date().toISOString()});
  assert.throws(()=>intent.cleanup.settle('attempt',observation),hasCode('ATTEMPT_CLEANUP_TRANSITION_INVALID'));
  const uncertain=intent.cleanup.settle('attempt',{outcome:'uncertain',method:'iterator-unavailable',reason:'error'});
  assert.equal(uncertain.state,'uncertain');assert.equal(uncertain.dispatchedAt,undefined,'Uncertain evidence may predate a failed cleanup dispatch journal');
  const dispatched=fixture(t);dispatched.dispatch();assert.throws(()=>dispatched.cleanup.settle('attempt',observation),hasCode('ATTEMPT_CLEANUP_TRANSITION_INVALID'));
});

test('invalid request/observations reject accessors/proxies/hidden fields without invoking them',t=>{
  const f=fixture(t);let reads=0;
  const accessor={...f.identity};Object.defineProperty(accessor,'requestBytes',{enumerable:true,get:()=>{reads++;return 100;}});
  for(const supplied of [accessor,new Proxy(f.identity,{}),{...f.identity,[Symbol('hidden')]:true},{...f.identity,requestBytes:ATTEMPT_CLEANUP_LIMITS.maxRequestBytes+1},{...f.identity,createdAt:'2026-10-07'},null]) {
    assert.throws(()=>f.cleanup.create(supplied as AttemptCleanupIdentity),hasCode('INVALID_ATTEMPT_CLEANUP'));
  }
  assert.equal(reads,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM attempt_cleanup').get()?.n,0);
  f.dispatch();
  for(const supplied of [{outcome:'confirmed',method:'return-missing',reason:'error'},{outcome:'not-dispatched',method:'iterator-return-done',reason:'cancel'},
    {outcome:'confirmed',method:'iterator-next-done',reason:'consumer-close'}, {outcome:'uncertain',method:'recovery',reason:'error'},
    {outcome:'uncertain',method:'return-rejected',reason:'error',rawBody:'must not be retained'}])assert.throws(()=>f.cleanup.settle('attempt',supplied as AttemptCleanupSettlement),hasCode('INVALID_ATTEMPT_CLEANUP'));
  assert.equal(f.cleanup.get('attempt').state,'dispatched');
});

test('observed provider request IDs are bounded and match the immutable ordinary Attempt',t=>{
  const f=fixture(t);f.dispatch();
  const current=f.store.getAttempt('attempt');f.store.putAttempt({...current,state:'streaming',providerRequestId:'request-from-provider'});
  assert.throws(()=>f.cleanup.settle('attempt',{outcome:'confirmed',method:'iterator-return-done',reason:'error',providerRequestId:'different'}),hasCode('ATTEMPT_CLEANUP_BINDING_MISMATCH'));
  assert.equal(f.cleanup.settle('attempt',{outcome:'confirmed',method:'iterator-return-done',reason:'error',providerRequestId:'request-from-provider'}).providerRequestId,'request-from-provider');
});

test('foreign owner and excessive record sizes reject before cleanup JSON is fetched',t=>{
  const f=fixture(t);f.cleanup.create(f.identity);let payloadReads=0;
  const original=f.db.prepare.bind(f.db);
  f.db.prepare=((sql:string)=>{if(/^SELECT data FROM attempt_cleanup/u.test(sql))payloadReads++;return original(sql);}) as typeof f.db.prepare;
  try {
    f.db.prepare("UPDATE attempt_cleanup SET data='{' WHERE attempt_id='attempt'").run();
    assert.throws(()=>f.cleanup.get('attempt','foreign'),hasCode('ATTEMPT_CLEANUP_BINDING_MISMATCH'));assert.equal(payloadReads,0);
    assert.throws(()=>f.cleanup.get('attempt','session'),hasCode('INVALID_ATTEMPT_CLEANUP'));assert.equal(payloadReads,1);
    f.db.exec('PRAGMA ignore_check_constraints=ON');f.db.prepare('UPDATE attempt_cleanup SET data=? WHERE attempt_id=?').run('x'.repeat(16385),'attempt');f.db.exec('PRAGMA ignore_check_constraints=OFF');
    payloadReads=0;assert.throws(()=>f.cleanup.get('attempt'),hasCode('ATTEMPT_CLEANUP_LIMIT'));assert.equal(payloadReads,0);
  } finally {f.db.prepare=original;}
});

test('Run owner byte preflight occurs before Run hook or cleanup payload fetch',t=>{
  const f=fixture(t);f.cleanup.create(f.identity);let runReads=0,cleanupReads=0;
  const original=f.db.prepare.bind(f.db);
  f.db.prepare=((sql:string)=>{if(/^SELECT data FROM runs/u.test(sql))runReads++;if(/^SELECT data FROM attempt_cleanup/u.test(sql))cleanupReads++;return original(sql);}) as typeof f.db.prepare;
  try {
    f.db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify({padding:'x'.repeat(ATTEMPT_CLEANUP_LIMITS.maxOwnerBytes)}),f.run.id);
    assert.throws(()=>f.cleanup.get('attempt'),hasCode('ATTEMPT_CLEANUP_LIMIT'));assert.equal(runReads,0);assert.equal(cleanupReads,0);
  } finally {f.db.prepare=original;}
});

test('valid large historical Turn input identity snapshots retain 1MiB owner compatibility',t=>{
  const f=fixture(t,{largeTurnInputs:true});
  const bytes=Number(f.db.prepare("SELECT length(CAST(data AS BLOB)) AS bytes FROM session_turns WHERE id='turn'").get()!.bytes);
  assert.ok(bytes>65_536&&bytes<ATTEMPT_CLEANUP_LIMITS.maxOwnerBytes);
  assert.equal(f.store.getTurn('turn').inputIds.length,301,'Native putTurn validated each matching promoted input before cleanup creation');
  f.dispatch();assert.equal(f.cleanup.settle('attempt',{outcome:'confirmed',method:'iterator-next-done',reason:'natural-done'}).cleanupConfirmed,true);
});

test('stored SQL/payload owner, request, context and timestamp mutations fail closed',t=>{
  for(const target of ['cleanup-request','attempt-owner','turn-index','run-owner','session-owner','workspace-owner','context-owner','timestamp'] as const) {
    const f=fixture(t,{context:true});f.dispatch();
    if(target==='cleanup-request')f.db.prepare("UPDATE attempt_cleanup SET data=json_set(data,'$.requestSha256',?) WHERE attempt_id='attempt'").run(hash('different'));
    if(target==='attempt-owner')f.db.exec("UPDATE provider_attempts SET data=json_set(data,'$.runId','foreign') WHERE id='attempt'");
    if(target==='turn-index')f.db.exec("UPDATE session_turns SET data=json_set(data,'$.index',1) WHERE id='turn'");
    if(target==='run-owner')f.db.prepare("UPDATE runs SET data=json_set(data,'$.workspaceId','foreign') WHERE id=?").run(f.run.id);
    if(target==='session-owner')f.db.exec("UPDATE sessions SET data=json_set(data,'$.workspaceId','foreign') WHERE id='session'");
    if(target==='workspace-owner')f.db.exec("UPDATE workspaces SET data=json_set(data,'$.id','foreign') WHERE id='workspace'");
    if(target==='context-owner')f.db.exec("UPDATE context_revisions SET data=json_set(data,'$.sessionId','foreign') WHERE id='context'");
    if(target==='timestamp')f.db.exec("UPDATE attempt_cleanup SET data=json_set(data,'$.updatedAt','2000-01-01T00:00:00.000Z') WHERE attempt_id='attempt'");
    assert.throws(()=>f.cleanup.get('attempt'),target==='timestamp'?hasCode('INVALID_ATTEMPT_CLEANUP'):hasCode('ATTEMPT_CLEANUP_BINDING_MISMATCH'));
  }
});

test('native and v1 cleanup audits roll back together with state and sequences',t=>{
  for(const table of ['session_events','events'] as const) {
    const f=fixture(t);f.dispatch();const before=f.cleanup.get('attempt'),v1=f.store.readEvents('session',0),v2=f.store.readSessionEvents('session',0);
    f.db.exec(`CREATE TRIGGER reject_cleanup BEFORE INSERT ON ${table} WHEN NEW.type='provider.cleanup.confirmed' BEGIN SELECT RAISE(ABORT,'cleanup fixture'); END`);
    assert.throws(()=>f.cleanup.settle('attempt',{outcome:'confirmed',method:'iterator-next-done',reason:'natural-done'}),/cleanup fixture/u);
    assert.deepEqual(f.cleanup.get('attempt'),before);assert.deepEqual(f.store.readEvents('session',0),v1);assert.deepEqual(f.store.readSessionEvents('session',0),v2);
  }
});

test('terminal Run and uncertain ordinary outcome accept cleanup observation without rewriting execution',t=>{
  const f=fixture(t);f.dispatch();const current=f.store.getAttempt('attempt');
  f.store.putAttempt({...current,state:'uncertain',completedAt:new Date().toISOString(),uncertainty:{kind:'provider_dispatch',message:'Original outcome remains unknown',requiresRecovery:true}});
  f.store.putTurn({...f.turn,state:'uncertain',completedAt:new Date().toISOString(),uncertainty:{kind:'provider_dispatch',message:'Unknown turn',requiresRecovery:true}});
  f.store.commit(f.run.id,'run.failed',{}, {run:{state:'failed'}});
  const ordinary=f.store.getAttempt('attempt'),turn=f.store.getTurn('turn'),run=f.store.getRun(f.run.id);
  const result=f.cleanup.settle('attempt',{outcome:'confirmed',method:'iterator-return-done',reason:'error'});
  assert.equal(result.cleanupConfirmed,true);assert.deepEqual(f.store.getAttempt('attempt'),ordinary);assert.deepEqual(f.store.getTurn('turn'),turn);assert.deepEqual(f.store.getRun(f.run.id),run);
  assert.deepEqual(f.cleanup.create(f.identity),result,'Exact identity receipt precedes active Run guard');
});

test('startup recovery uses only recorded cleanup intent and does not infer proof from ordinary states',t=>{
  for(const kind of ['legacy','prepared','dispatched','ordinary-dispatch-only','confirmed','uncertain'] as const) {
    const f=fixture(t);const sessions=new Set<string>();
    if(kind!=='legacy')f.cleanup.create(f.identity);
    if(['dispatched','confirmed','uncertain'].includes(kind))f.cleanup.dispatch('attempt');
    if(kind==='ordinary-dispatch-only')f.store.putAttempt({...f.attempt,state:'dispatched',dispatchedAt:new Date().toISOString()});
    if(kind==='confirmed')f.cleanup.settle('attempt',{outcome:'confirmed',method:'iterator-next-done',reason:'natural-done'});
    if(kind==='uncertain')f.cleanup.settle('attempt',{outcome:'uncertain',method:'return-timeout',reason:'error'});
    const ordinary=f.store.getAttempt('attempt'),before=kind==='legacy'?undefined:f.cleanup.get('attempt');
    assert.throws(()=>f.cleanup.recoverInTransaction(sessions),hasCode('STORAGE_TRANSACTION_REQUIRED'));
    f.transaction(()=>f.cleanup.recoverInTransaction(sessions));
    assert.deepEqual(f.store.getAttempt('attempt'),ordinary);
    if(kind==='legacy')assert.throws(()=>f.cleanup.get('attempt'),hasCode('ATTEMPT_CLEANUP_NOT_FOUND'));
    else if(kind==='prepared'){assert.equal(f.cleanup.get('attempt').state,'not-dispatched');assert.equal(f.cleanup.get('attempt').cleanupConfirmed,null);}
    else if(['confirmed','uncertain'].includes(kind))assert.deepEqual(f.cleanup.get('attempt'),before);
    else {assert.equal(f.cleanup.get('attempt').state,'uncertain');assert.equal(f.cleanup.get('attempt').method,'recovery');}
    const events=f.store.readSessionEvents('session',0);f.transaction(()=>f.cleanup.recoverInTransaction(sessions));assert.deepEqual(f.store.readSessionEvents('session',0),events);
    assert.equal(sessions.has('session'),['prepared','dispatched','ordinary-dispatch-only'].includes(kind));
  }
});

test('startup cleanup audit failure rolls back recovery observation and does not create proof on retry',t=>{
  const f=fixture(t);f.dispatch();const before=f.cleanup.get('attempt'),events=f.store.readSessionEvents('session',0);
  f.db.exec("CREATE TRIGGER fail_cleanup_recovery BEFORE INSERT ON events WHEN NEW.type='provider.cleanup.uncertain' BEGIN SELECT RAISE(ABORT,'recovery fixture'); END");
  assert.throws(()=>f.transaction(()=>f.cleanup.recoverInTransaction(new Set())),/recovery fixture/u);
  assert.deepEqual(f.cleanup.get('attempt'),before);assert.deepEqual(f.store.readSessionEvents('session',0),events);
  f.db.exec('DROP TRIGGER fail_cleanup_recovery');f.transaction(()=>f.cleanup.recoverInTransaction(new Set()));
  assert.equal(f.cleanup.get('attempt').state,'uncertain');assert.equal(f.cleanup.get('attempt').cleanupConfirmed,false);
});

test('canonical proof digest is key-order independent and excludes unsafe or changed evidence',t=>{
  const f=fixture(t);f.dispatch();const proof=f.cleanup.settle('attempt',{outcome:'confirmed',method:'iterator-next-done',reason:'natural-done'});
  const reversed=Object.fromEntries(Object.entries(proof).reverse()) as typeof proof;
  assert.equal(canonicalAttemptCleanupSha256(proof),canonicalAttemptCleanupSha256(reversed));
  assert.notEqual(canonicalAttemptCleanupSha256(proof),canonicalAttemptCleanupSha256({...proof,requestSha256:hash('changed')}));
  assert.throws(()=>canonicalAttemptCleanupSha256(new Proxy(proof,{})),hasCode('INVALID_ATTEMPT_CLEANUP'));
});
