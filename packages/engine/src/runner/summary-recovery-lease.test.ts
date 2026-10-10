import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import { DEFAULT_LIMITS, EngineError, isTerminal, type EngineEvent, type InputRecord, type Message, type Run, type RunReceipt, type Session, type SessionControl, type SubmitInput, type Workspace } from '@moodcode/contracts';
import type { EngineStore, ProviderAdapter, SessionEngineStore, SessionInboxPort } from '../ports.js';
import { RunCoordinator } from './index.js';
import { InputScheduler } from './input-scheduler.js';

const stamp = '2026-10-07T00:00:00.000Z';
const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
const clone = <T>(value: T): T => structuredClone(value);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(condition: () => boolean) { const end = Date.now()+2000; while (!condition()) { if (Date.now()>end) assert.fail('Controlled fixture did not reach its boundary'); await tick(); } }

/** Bounded fake durable store; SQL-active state and runtime ownership are independently controlled. */
function fixture(hold?: ReturnType<typeof deferred>) {
  const workspaces = new Map<string,Workspace>(['a','b'].map(id => [id,{ id,root:`/fake/${id}`,gitRoot:`/fake/${id}`,branch:null,createdAt:stamp }]));
  const sessions = new Map<string,Session>(['a','b'].map(id => [`session-${id}`,{ id:`session-${id}`,workspaceId:id,title:id,createdAt:stamp }]));
  const runs = new Map<string,Run>(), messages = new Map<string,Message>(), events: EngineEvent[] = [], summaryBlocked = new Set<string>();
  const receipts = new Map<string,{ fingerprint: string; receipt: RunReceipt }>();
  let serial = 0, activeOverride: boolean | undefined, providerCalls = 0;
  const store: EngineStore = {
    putWorkspace: value => clone(value), listWorkspaces: () => [...workspaces.values()].map(clone),
    getWorkspace: id => { const value=workspaces.get(id); if (!value) throw new EngineError('WORKSPACE_NOT_FOUND','Unknown fixture workspace'); return clone(value); },
    createSession: value => { sessions.set(value.id,clone(value)); return clone(value); },
    getSession: id => { const value=sessions.get(id); if (!value) throw new EngineError('SESSION_NOT_FOUND','Unknown fixture session'); return clone(value); },
    listSessions: workspaceId => [...sessions.values()].filter(session => session.workspaceId===workspaceId).map(clone),
    hasUncertainSummaries: workspaceId => summaryBlocked.has(workspaceId),
    hasRunRequest: (sessionId,requestId) => receipts.has(`${sessionId}/${requestId}`),
    hasActiveRuns: (workspaceId,excluded) => activeOverride ?? [...runs.values()].some(run => run.workspaceId===workspaceId && run.id!==excluded && !isTerminal(run.state)),
    admit: input => {
      const key=`${input.sessionId}/${input.requestId}`, fingerprint=JSON.stringify(input), known=receipts.get(key);
      if (known) { if (known.fingerprint!==fingerprint) throw new EngineError('REQUEST_ID_CONFLICT','Conflicting request'); return {...clone(known.receipt),duplicate:true}; }
      const session=store.getSession(input.sessionId);
      if (store.hasActiveRuns!(session.workspaceId)) throw new EngineError('WORKSPACE_BUSY','Persisted active Run');
      const run:Run={...clone(input),id:`run-${++serial}`,inputId:`input-${serial}`,workspaceId:session.workspaceId,state:'created',createdAt:stamp,updatedAt:stamp}; runs.set(run.id,run);
      messages.set(run.inputId,{id:run.inputId,runId:run.id,sessionId:run.sessionId,role:'user',content:run.prompt,createdAt:stamp});
      const event=store.commit(run.id,'input.admitted',{}), receipt:RunReceipt={runId:run.id,inputId:run.inputId,admittedSeq:event.seq,duplicate:false}; receipts.set(key,{fingerprint,receipt}); return clone(receipt);
    },
    getRun: id => { const run=runs.get(id); if (!run) throw new EngineError('RUN_NOT_FOUND','Unknown fixture Run'); return clone(run); },
    commit: (runId,type,payload,change={}) => {
      const run=runs.get(runId); assert.ok(run); if (change.run) Object.assign(run,clone(change.run)); if (change.message) messages.set(change.message.id,clone(change.message));
      const event:EngineEvent={schemaVersion:1,eventId:`event-${events.length+1}`,sessionId:run.sessionId,runId,seq:events.length+1,timestamp:stamp,type,payload:clone(payload)}; events.push(event); return clone(event);
    },
    getSnapshot: sessionId => ({session:store.getSession(sessionId),runs:[...runs.values()].filter(run=>run.sessionId===sessionId).map(clone),messages:[...messages.values()].filter(message=>message.sessionId===sessionId).map(clone),tools:[],approvals:[],lastSeq:events.length}),
    readEvents: (sessionId,afterSeq,limit=100) => events.filter(event=>event.sessionId===sessionId && event.seq>afterSeq).slice(0,limit).map(clone),
    async *subscribe(sessionId,afterSeq) { yield* store.readEvents(sessionId,afterSeq); },
    getApproval: () => { throw new EngineError('APPROVAL_NOT_FOUND','No approvals in fixture'); }, listCheckpoints: () => [], recoverInterrupted: () => [], close: () => {},
  };
  const provider:ProviderAdapter={id:'fixture',async *streamTurn(_request,signal) { providerCalls++; if (hold) await hold.promise; if (!signal.aborted) yield {type:'finish',reason:'stop'}; }};
  const runner=new RunCoordinator({store,providers:new Map([[provider.id,provider]]),tools:[],artifactDir:'/fake/artifacts',
    approvals:{async request(){throw new Error('Unexpected approval request');},decide(){throw new Error('Unexpected approval decision');},cancelRun(){}},buildContext:async request=>[{role:'user',content:request.snapshot.messages.at(-1)?.content??'fixture'}]});
  const input=(requestId='goal',workspace='a'):SubmitInput=>({sessionId:`session-${workspace}`,requestId,prompt:'Fixture goal',config:{providerId:'fixture',modelId:'local',mode:'build',limits:{...DEFAULT_LIMITS}}});
  return {runner,store,runs,summaryBlocked,input,events,get providerCalls(){return providerCalls;},overrideActive(value:boolean|undefined){activeOverride=value;}};
}

test('summary predicate is a live durable observation and does not permanently enter generic quarantine', async () => {
  const f=fixture();
  try {
    const saved=f.runner.submit(f.input()); await f.runner.waitForRun(saved.runId); await tick(); f.summaryBlocked.add('a');
    assert.throws(()=>f.runner.assertWorkspaceCleanupConfirmed('a'),hasCode('CLEANUP_PENDING'));
    assert.throws(()=>f.runner.submit(f.input('blocked')),hasCode('CLEANUP_PENDING'));
    assert.deepEqual(f.runner.submit(f.input()),{...saved,duplicate:true}); assert.throws(()=>f.runner.submit({...f.input(),prompt:'Conflicting goal'}),hasCode('REQUEST_ID_CONFLICT'));
    f.summaryBlocked.delete('a'); assert.doesNotThrow(()=>f.runner.assertWorkspaceAvailable('a'));
    const next=f.runner.submit(f.input('after-summary-ledger')); await f.runner.waitForRun(next.runId); assert.equal(f.providerCalls,2);
  } finally { await f.runner.close(); }
});

test('combined workspace proof owns admission and resume while durable duplicate requests stay replayable', async () => {
  const f = fixture(); let blocked = false, combinedCalls = 0, legacyCalls = 0;
  f.store.hasUncertainWorkspace = workspaceId => { combinedCalls++; assert.equal(workspaceId, 'a'); return blocked; };
  f.store.hasUncertainSummaries = () => { legacyCalls++; return true; };
  f.store.hasUncertainExecution = () => { legacyCalls++; return true; };
  try {
    const saved = f.runner.submit(f.input()); await f.runner.waitForRun(saved.runId); await tick();
    blocked = true;
    assert.throws(() => f.runner.assertWorkspaceCleanupConfirmed('a'), hasCode('CLEANUP_PENDING'));
    assert.throws(() => f.runner.submit(f.input('combined-blocked')), hasCode('CLEANUP_PENDING'));
    assert.deepEqual(f.runner.submit(f.input()), { ...saved, duplicate: true });
    assert.throws(() => f.runner.submit({ ...f.input(), prompt: 'Conflicting combined goal' }), hasCode('REQUEST_ID_CONFLICT'));
    blocked = false; assert.doesNotThrow(() => f.runner.assertWorkspaceCleanupConfirmed('a'));
    const next = f.runner.submit(f.input('combined-clear')); await f.runner.waitForRun(next.runId);
    assert.ok(combinedCalls >= 6); assert.equal(legacyCalls, 0); assert.equal(f.providerCalls, 2);
  } finally { await f.runner.close(); }
});

test('custom stores without a combined predicate retain both legacy workspace blockers', async () => {
  const f = fixture(); let ordinaryBlocked = true, ordinaryCalls = 0;
  f.store.hasUncertainExecution = () => { ordinaryCalls++; return ordinaryBlocked; };
  try {
    assert.throws(() => f.runner.submit(f.input()), hasCode('CLEANUP_PENDING'));
    assert.throws(() => f.runner.assertWorkspaceCleanupConfirmed('a'), hasCode('CLEANUP_PENDING'));
    assert.equal(ordinaryCalls, 2); assert.equal(f.providerCalls, 0);
    ordinaryBlocked = false;
    const admitted = f.runner.submit(f.input()); await f.runner.waitForRun(admitted.runId);
    f.summaryBlocked.add('a'); assert.throws(() => f.runner.assertWorkspaceCleanupConfirmed('a'), hasCode('CLEANUP_PENDING'));
    assert.equal(f.providerCalls, 1);
  } finally { await f.runner.close(); }
});

test('audit-only uncertain receipts remain observations while exact identities and workspace lease exclusions stay intact', async () => {
  const f=fixture(), release=deferred(); let entered=false, idle=0;
  f.runner.setSessionHooks({boundary:()=>false,cancelled:()=>{},settled:()=>{},workspaceIdle:()=>{idle++;}});
  try {
    const receipt=f.runner.submit(f.input()); await f.runner.waitForRun(receipt.runId); await tick(); const beforeIdle=idle;
    f.summaryBlocked.add('a');
    const auditReceipt={state:'uncertain',cleanupConfirmed:false,executionBlocked:true,decision:'audit-only'};
    const audit=f.runner.withRecoveryDecisionLease('a',async()=>{entered=true;await release.promise;return auditReceipt;});
    assert.equal(entered,false); assert.deepEqual(f.runner.submit(f.input()),{...receipt,duplicate:true}); assert.throws(()=>f.runner.submit({...f.input(),prompt:'changed'}),hasCode('REQUEST_ID_CONFLICT'));
    await assert.rejects(f.runner.withRecoveryDecisionLease('a',async()=>0),hasCode('WORKSPACE_BUSY'));
    f.summaryBlocked.delete('a'); assert.throws(()=>f.runner.submit(f.input('new-during-audit')),hasCode('WORKSPACE_BUSY'));
    await assert.rejects(f.runner.withWorkspaceLease('a',async()=>0),hasCode('WORKSPACE_BUSY'));
    const independent=f.runner.submit(f.input('other-workspace','b')); await f.runner.waitForRun(independent.runId); await tick();
    const independentIdle=idle; await until(()=>entered); release.resolve(); assert.strictEqual(await audit,auditReceipt); assert.equal(idle,independentIdle);
    assert.ok(independentIdle>beforeIdle); assert.doesNotThrow(()=>f.runner.assertWorkspaceAvailable('a'));
  } finally { release.resolve(); await f.runner.close(); }
});

test('audit decisions cannot clear independent runtime quarantine and generic unsafe maintenance retains its original behavior', async () => {
  const f=fixture(); let callbacks=0;
  try {
    f.runner.quarantineWorkspace('a'); f.summaryBlocked.add('a'); f.summaryBlocked.delete('a');
    await assert.rejects(f.runner.withRecoveryDecisionLease('a',async()=>{callbacks++;return{cleanupConfirmed:false};}),hasCode('CLEANUP_PENDING'));
    assert.equal(callbacks,0); assert.throws(()=>f.runner.assertWorkspaceAvailable('a'),hasCode('CLEANUP_PENDING'));
    await assert.rejects(f.runner.withWorkspaceLease('b',async()=>({cleanupConfirmed:false})),hasCode('CLEANUP_UNCERTAIN'));
    await assert.rejects(f.runner.withRecoveryDecisionLease('b',async()=>{callbacks++;}),hasCode('CLEANUP_PENDING'));
    assert.equal(callbacks,0);
  } finally { await f.runner.close(); }
});

test('live owner, unowned persisted Run and ordinary maintenance each prevent summary audit callbacks', async () => {
  const held=deferred(), f=fixture(held); let callbacks=0;
  try {
    f.overrideActive(false); const active=f.runner.submit(f.input());
    await assert.rejects(f.runner.withRecoveryDecisionLease('a',async()=>{callbacks++;}),hasCode('WORKSPACE_BUSY'));
    assert.equal(callbacks,0); held.resolve(); await f.runner.waitForRun(active.runId); await tick(); f.overrideActive(undefined);
    const unowned=f.store.admit(f.input('persisted-unowned'));
    await assert.rejects(f.runner.withRecoveryDecisionLease('a',async()=>{callbacks++;}),hasCode('WORKSPACE_BUSY'));
    f.store.commit(unowned.runId,'run.cancelled',{}, {run:{state:'cancelled'}});
    const release=deferred(), maintenance=f.runner.withWorkspaceLease('a',async()=>{await release.promise;});
    await assert.rejects(f.runner.withRecoveryDecisionLease('a',async()=>{callbacks++;}),hasCode('WORKSPACE_BUSY'));
    assert.equal(callbacks,0); release.resolve(); await maintenance;
    await assert.rejects(f.runner.withRecoveryDecisionLease('unknown',async()=>{callbacks++;}),hasCode('WORKSPACE_NOT_FOUND'));
    assert.equal(callbacks,0);
  } finally { held.resolve(); await f.runner.close(); }
});

test('close joins a started audit lease and preserves its audit receipt without emitting an idle hook', async () => {
  const f=fixture(), release=deferred(); let signal:AbortSignal|undefined, settled=false, closed=false, idle=0;
  f.runner.setSessionHooks({boundary:()=>false,cancelled:()=>{},settled:()=>{},workspaceIdle:()=>{idle++;}});
  const receipt={state:'uncertain',cleanupConfirmed:false,decision:'audit-only'};
  const lease=f.runner.withRecoveryDecisionLease('a',async value=>{signal=value;try {await release.promise;return receipt;} finally {settled=true;}});
  try {
    await until(()=>signal!==undefined); const closing=f.runner.close().then(()=>{closed=true;});
    assert.equal(signal!.aborted,true); await tick(); assert.equal(closed,false); assert.equal(settled,false);
    await assert.rejects(f.runner.withRecoveryDecisionLease('b',async()=>0),hasCode('ENGINE_CLOSED'));
    release.resolve(); assert.strictEqual(await lease,receipt); await closing; assert.equal(settled,true); assert.equal(idle,0);
  } finally { release.resolve(); await f.runner.close(); }
});

test('close before the audit microtask skips the decision and an audit error does not masquerade as effect cleanup uncertainty', async () => {
  const f=fixture(); let callbacks=0;
  const lease=f.runner.withRecoveryDecisionLease('a',async()=>{callbacks++;return{cleanupConfirmed:false};});
  const observed=assert.rejects(lease,hasCode('ENGINE_CLOSED')); await f.runner.close(); await observed; assert.equal(callbacks,0);
  const next=fixture(); const expected=new EngineError('CLEANUP_UNCERTAIN','Stored provider uncertainty is an audit observation');
  try {
    await assert.rejects(next.runner.withRecoveryDecisionLease('a',async()=>{throw expected;}),error=>error===expected);
    assert.doesNotThrow(()=>next.runner.assertWorkspaceAvailable('a'));
  } finally { await next.runner.close(); }
});

test('retiring an unpaused ticket waiting on the audit lease prevents automatic promotion until explicit resume', async () => {
  const f=fixture(), pending:InputRecord[]=[{schemaVersion:2,...f.input('queued'),id:'queued',workspaceId:'a',delivery:'queue',state:'pending',admittedSeq:1,createdAt:stamp,updatedAt:stamp}], controls=new Map<string,SessionControl>();
  for(const id of ['session-a','session-b'])controls.set(id,{sessionId:id,paused:false,revision:1,updatedAt:stamp});
  let promotions=0;
  const inbox:Pick<SessionInboxPort,'getSessionControl'|'setSessionPaused'|'pendingInputs'|'promoteInput'>={
    getSessionControl:id=>clone(controls.get(id)!),
    setSessionPaused:(id,paused,reason)=>{const value:SessionControl={sessionId:id,paused,revision:controls.get(id)!.revision+1,updatedAt:stamp,...(reason?{reason}:{})};controls.set(id,value);return clone(value);},
    pendingInputs:(sessionId)=>pending.filter(value=>value.sessionId===sessionId && value.state==='pending').map(clone),
    promoteInput:id=>{promotions++;const input=pending.find(value=>value.id===id)!;const receipt=f.store.admit({sessionId:input.sessionId,requestId:input.requestId,prompt:input.prompt,config:input.config});input.state='promoted';input.runId=receipt.runId;return{input:clone(input),run:f.store.getRun(receipt.runId),receipt};},
  };
  const scheduler=new InputScheduler({store:Object.assign(f.store,inbox) as SessionEngineStore,coordinator:f.runner});
  const release=deferred(); let entered=false;
  try {
    const before=clone(controls.get('session-a')!);
    const audit=f.runner.withRecoveryDecisionLease('a',async()=>{entered=true;await release.promise;scheduler.holdRecoveryWorkspace('a');return{state:'uncertain',cleanupConfirmed:false};});
    await until(()=>entered);const flight=scheduler.wake('session-a');let finished=false;void flight.then(()=>{finished=true;});await tick();
    assert.equal(finished,false,'The unpaused queued ticket is genuinely waiting on workspace admission');
    assert.equal(promotions,0); assert.equal(f.providerCalls,0); assert.deepEqual(controls.get('session-a'),before); assert.equal(pending[0]!.state,'pending');
    release.resolve();await audit;await flight;await tick();
    assert.equal(promotions,0); assert.equal(f.providerCalls,0); assert.deepEqual(controls.get('session-a'),before);
    scheduler.resume('session-a');await scheduler.waitForSession('session-a');assert.equal(promotions,1);assert.equal(f.providerCalls,1);assert.equal(pending[0]!.state,'promoted');
  } finally { release.resolve();await Promise.all([scheduler.close(),f.runner.close()]); }
});
