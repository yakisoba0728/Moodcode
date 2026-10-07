import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as tick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { EngineError, type ArtifactReference, type RunConfig } from '@moodcode/contracts';
import { createEngine, type EngineOptions, type MoodcodeEngine } from '../engine.js';
import { exportEngineArchive, importEngineArchive } from '../storage/archive.js';
import { SqliteStore } from '../storage/index.js';
import { DB_VERSION } from '../storage/migrations.js';
import { acquireExecutionLock } from '../tools/command/execution-lock.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import type { ProviderRecoveryRequest } from '../recovery/provider-contract.js';

// Authored synthetic iterators and private temporary storage exercise the real
// engine. No account, GUI, command tool, remote transport or existing data is used.
const goal = 'Synthetic provider-recovery original goal.';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function construct(options:EngineOptions,onRead:()=>void):MoodcodeEngine {
  const original=SqliteStore.prototype.getSnapshot;
  const trap=()=>{onRead();throw new Error('Provider recovery forbids whole session snapshots, including startup');};
  SqliteStore.prototype.getSnapshot=trap;
  try{const engine=createEngine(options);engine.store.getSnapshot=trap;return engine;}finally{SqliteStore.prototype.getSnapshot=original;}
}
type Failure = 'transport' | 'request-timeout' | 'inactivity-timeout' | 'cancel' | 'protocol';
type Cleanup = 'done' | 'missing' | 'rejected' | 'not-done';
interface Observation { request: TurnRequest; returns: number; proposals: number; entered: ReturnType<typeof deferred> }
interface Options { failure?: Failure; cleanup?: Cleanup; partial?: boolean; priorRead?: boolean; steer?: boolean; independentSummary?: boolean }
interface Fixture {
  root: string; repository: string; dbPath: string; artifactDir: string; reader: DatabaseSync; engine: MoodcodeEngine; options: EngineOptions;
  runId: string; attemptId: string; turnId: string; steerId?: string; observed: Observation[]; fullReads(): number; reopen(): Promise<void>;
  original(): unknown; context(): unknown; rows(): number;
}
function media(request: TurnRequest): ArtifactReference {
  // This is a public media reference emitted by a synthetic adapter, not an
  // assertion that a real provider has delivered or decoded an image.
  const createdAt = new Date().toISOString();
  return { id: 'synthetic-public-media-reference', identity: { sessionId: 'session', runId: request.runId, toolCallId: 'synthetic-media-producer', turnId: request.turnId!, attemptId: request.attemptId! },
    sha256: sha('Synthetic media bytes'), storedBytes: 21, observedBytes: 21, producerTruncatedBytes: 0, artifactTruncatedBytes: 0,
    createdAt, expiresAt: new Date(Date.now() + 3600000).toISOString(), complete: true, outcome: 'completed' };
}
function iterator(item: Observation, signal: AbortSignal, events: ProviderEvent[], options: Options, fail: boolean): AsyncIterableIterator<ProviderEvent> {
  let index = 0;
  const value: AsyncIterableIterator<ProviderEvent> = { [Symbol.asyncIterator]() { return value; }, async next() {
    if (index < events.length) { const event=events[index++]!;if(event.type==='tool.call')item.proposals++;return { done: false, value: event }; }
    item.entered.resolve();
    if (!fail) return { done: true, value: undefined };
    if (['request-timeout', 'inactivity-timeout', 'cancel'].includes(options.failure ?? 'transport')) return new Promise<IteratorResult<ProviderEvent>>((_, reject) => {
      const abort = () => reject(signal.reason ?? new EngineError('RUN_CANCELLED', 'Synthetic cancellation observed'));
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
    throw new EngineError('PROVIDER_TRANSPORT_ERROR', 'Synthetic remote outcome is unknown after local iterator closure');
  } };
  if (options.cleanup !== 'missing') value.return = async () => {
    item.returns++;
    if (options.cleanup === 'rejected') throw new Error('Synthetic return rejected');
    return options.cleanup === 'not-done' ? { done: false, value: { type: 'progress' } } : { done: true, value: undefined };
  };
  return value;
}
async function fixture(t: TestContext, specification: Options = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-provider-recovery-'))), repository = join(root, 'repository'), dbPath = join(root, 'engine.sqlite'), artifactDir = join(root, 'artifacts');
  await mkdir(repository); await writeFile(join(repository, 'source.txt'), 'Synthetic completed read observation.\n');
  let f!: Fixture, reads = 0; const observed: Observation[] = [], dispatched = deferred();
  const provider: ProviderAdapter = { id: 'provider-recovery-fixture', streamTurn(request, signal) {
    const item: Observation = { request: structuredClone(request), returns: 0, proposals: 0, entered: deferred() }; observed.push(item); dispatched.resolve();
    if(specification.independentSummary&&request.tools.length===0)return iterator(item,signal,[{type:'usage',inputTokens:9},{type:'text.delta',delta:'Synthetic independent partial memory.'}],{cleanup:'missing'},true);
    if(specification.independentSummary&&request.messages.findLast(message=>message.role==='user')?.content==='Synthetic history for an independent summary.')return iterator(item,signal,[{type:'text.delta',delta:'SYNTHETIC_NONCE=0123456789abcdef0123456789abcdef\n'+'Synthetic historical discussion. '.repeat(285)},{type:'finish',reason:'stop'}],{},false);
    const newestUser=request.messages.findLast(message=>message.role==='user')?.content;
    const fail = newestUser===goal||newestUser===goal+' Exact promoted steering constraint.';
    if (fail && specification.priorRead && request.turnIndex === 0) {
      if(specification.steer)f.steerId=f.engine.scheduler.accept({sessionId:'session',requestId:'actual-steer',prompt:goal+' Exact promoted steering constraint.',config:f.engine.store.getRun(request.runId).config,delivery:'steer'}).inputId;
      return iterator(item, signal, [{ type: 'tool.call', call: { id: 'completed-read', name: 'read_file', input: { path: 'source.txt' } } }, { type: 'finish', reason: 'tool_calls' }], specification, false);
    }
    const events: ProviderEvent[] = fail ? [{ type: 'progress', providerRequestId: 'synthetic-request' }, { type: 'usage', inputTokens: 11, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1 }] : [{ type: 'text.delta', delta: 'Explicit new independent work completed.' }, { type: 'finish', reason: 'stop' }];
    if (fail && specification.partial) events.push({ type: 'text.delta', delta: 'Synthetic partial public answer.' }, { type: 'reasoning.delta', delta: 'Synthetic public reasoning summary.' }, { type: 'media', mime: 'image/png', name: 'public-reference', artifact: media(request) }, { type: 'tool.call', call: { id: 'unexecuted-proposal', name: 'read_file', input: { path: 'source.txt' } } });
    if (fail && specification.failure === 'protocol') events.push({ type: 'usage', inputTokens: -1 });
    return iterator(item, signal, events, specification, fail);
  } };
  const budgets: Partial<NonNullable<RunConfig['budgets']>> = specification.failure === 'request-timeout' ? { providerRequestTimeoutMs: 100 } : specification.failure === 'inactivity-timeout' ? { providerInactivityTimeoutMs: 100 } : {};
  const options: EngineOptions = { dbPath, artifactDir, providers: [provider], allowedToolNames: ['read_file'], defaults: { providerId: provider.id, modelId: 'fixture-model', mode: 'plan',
    limits: { maxContextBytes: 262144, maxOutputBytes: 32768, maxDurationMs: 10000 }, budgets: { maxProviderAttempts: 2, retryBaseDelayMs: 1, providerRequestTimeoutMs: 5000, providerInactivityTimeoutMs: 5000, ...budgets } } };
  const engine = construct(options,()=>reads++), reader = new DatabaseSync(dbPath, { readOnly: true });
  const trap = () => { f.engine.store.getSnapshot = () => { reads++; throw new Error('Provider recovery forbids whole session snapshots'); }; };
  f = { root, repository, dbPath, artifactDir, reader, engine, options, runId: '', attemptId: '', turnId: '', observed,
    fullReads: () => reads, async reopen() { await f.engine.close(); f.engine = construct(options,()=>reads++); trap(); await tick(); },
    original() { const tables = ['runs', 'session_turns', 'provider_attempts', 'attempt_cleanup', 'attempt_usage', 'messages', 'message_parts', 'tools', 'context_revisions'];
      return Object.fromEntries(tables.map(table => [table, reader.prepare(`SELECT data FROM ${table} WHERE ${table === 'runs' ? 'id' : 'run_id'}=? ORDER BY rowid LIMIT 128`).all(f.runId).map(row => String(row.data))])); },
    context() { return ['context.head','context.memory','context.active_memory'].map(kind => f.engine.store.getSessionDocument('session', kind)); },
    rows() { return Number(reader.prepare('SELECT count(*) AS n FROM provider_recovery_acknowledgments').get()!.n); },
  };
  t.after(async () => { try { await f.engine.close(); } finally { reader.close(); await rm(root, { recursive: true, force: true }); } });
  const now = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt: now });
  for (const id of ['session', 'other-session']) engine.store.createSession({ id, workspaceId: 'workspace', title: id, createdAt: now }); trap();
  const receipt = engine.coordinator.submit({ sessionId: 'session', requestId: 'primary', prompt: goal, config: engine.getCapabilities().defaults }); f.runId = receipt.runId;
  const done = engine.waitForRun(receipt.runId);
  if (specification.failure === 'cancel') { await Promise.race([dispatched.promise, done.then(run => assert.fail(`No dispatch before ${run.state}`))]); await observed[0]!.entered.promise; engine.coordinator.cancel(receipt.runId); }
  const run = await done; await engine.waitForSession('session');
  assert.equal(run.state, specification.failure === 'cancel' ? 'cancelled' : 'failed');
  const latest = observed.findLast(item => item.request.runId === f.runId)!; f.attemptId = latest.request.attemptId!; f.turnId = latest.request.turnId!;
  assert.ok(f.attemptId); assert.ok(f.turnId); assert.equal(observed.length, specification.priorRead ? 2 : 1); return f;
}
function request(f: Fixture, requestId = 'host-decision'): ProviderRecoveryRequest {
  const preview = f.engine.getProviderRecoveryPreview('session', f.attemptId); assert.equal(preview.status, 'eligible', JSON.stringify(preview)); assert.match(preview.fingerprint!, /^[a-f0-9]{64}$/u);
  const actual = f.observed.findLast(item => item.request.attemptId === f.attemptId)!.request;
  assert.equal(preview.requestSha256, sha(JSON.stringify(actual))); assert.equal(preview.requestBytes, Buffer.byteLength(JSON.stringify(actual)));
  assert.equal(JSON.stringify(preview).includes('Synthetic partial public'), false);
  return { sessionId: 'session', attemptId: f.attemptId, requestId, fingerprint: preview.fingerprint!, acknowledged: true };
}
function count(f: Fixture, table: string, type: string): number { return Number(f.reader.prepare(`SELECT count(*) AS n FROM ${table} WHERE type=? AND run_id=?`).get(type, f.runId)!.n); }
function blocked(f: Fixture) {
  for (const sessionId of ['session','other-session']) assert.throws(() => f.engine.coordinator.submit({ sessionId, requestId: 'new-blocked', prompt: 'Explicit new work', config: f.engine.getCapabilities().defaults }), code('CLEANUP_PENDING'));
  assert.throws(() => f.engine.scheduler.resume('other-session'), code('CLEANUP_PENDING'));
}
async function retry(f: Fixture) {
  const calls = f.observed.length, original = f.engine.store.getRun(f.runId);
  const receipt = f.engine.coordinator.submit({ sessionId: 'session', requestId: 'primary', prompt: goal, config: original.config }); assert.equal(receipt.duplicate, true); assert.equal(receipt.runId, original.id);
  assert.throws(() => f.engine.coordinator.submit({ sessionId: 'session', requestId: 'primary', prompt: goal + ' changed', config: original.config }), code('REQUEST_ID_CONFLICT'));
  await tick(); assert.equal(f.observed.length, calls); assert.equal(f.fullReads(), 0);
}

for (const failure of ['transport','request-timeout','inactivity-timeout'] as const) test(`actual ${failure} with partial text/reasoning/media/tool proposal requires restart then exact host acknowledgment`, { timeout: 30000 }, async t => {
  const f = await fixture(t, { failure, partial: true }), original = f.original(), context = f.context();
  assert.equal(f.engine.store.getAttempt(f.attemptId).state, 'uncertain'); assert.equal(f.engine.store.getTurn(f.turnId).state, 'uncertain');
  assert.equal(f.engine.getAttemptCleanup('session', f.attemptId).cleanupConfirmed, true); assert.equal(f.engine.getAttemptCleanup('session', f.attemptId).method, 'iterator-return-done');
  const parts = f.engine.store.listParts(f.turnId); assert.deepEqual(parts.map(part => part.type), ['text','reasoning','media','tool']);
  assert.equal(f.observed[0]!.proposals,1);
  const proposal=parts.find(part=>part.type==='tool');assert.ok(proposal&&proposal.type==='tool');assert.equal(proposal.providerCallId,'unexecuted-proposal');assert.equal(proposal.state,'interrupted');assert.equal(proposal.result,undefined);assert.deepEqual(proposal.input,{path:'source.txt'});
  assert.equal(Number(f.reader.prepare('SELECT count(*) AS n FROM tools WHERE run_id=?').get(f.runId)!.n), 0, 'A proposed tool is not executed after interrupted provider transport');
  const sameBoot = f.engine.getProviderRecoveryPreview('session', f.attemptId); assert.equal(sameBoot.status, 'blocked'); assert.ok(sameBoot.blockers.includes('PROVIDER_RECOVERY_RESTART_REQUIRED')); blocked(f); await retry(f);
  await f.reopen(); const decision = request(f), control = f.engine.store.getSessionControl('session'), receipt = await f.engine.acknowledgeProviderRecovery(decision);
  assert.equal(receipt.state, 'uncertain'); assert.equal(receipt.cleanupConfirmed, true); assert.equal(receipt.providerOutcomeConfirmed, false); assert.equal(receipt.providerRetried, false); assert.equal(receipt.executionResumed, false); assert.equal(receipt.checkpointActivated, false);
  assert.deepEqual(f.original(), original); assert.deepEqual(f.context(), context); assert.deepEqual(f.engine.store.getSessionControl('session'), control); assert.equal(f.observed.length, 1); assert.equal(f.rows(), 1);
  assert.equal(count(f,'events','provider.recovery.acknowledged'), 1); assert.equal(count(f,'session_events','provider.recovery.acknowledged'), 1); assert.equal(f.engine.store.hasUncertainExecution('workspace'), false);
  assert.deepEqual(await f.engine.acknowledgeProviderRecovery(decision), { ...receipt, duplicate: true });
  for (let index = 0; index < 2; index++) { const next = f.engine.coordinator.submit({ sessionId: 'session', requestId: `new-${index}`, prompt: `Explicit new independent task ${index}`, config: f.engine.getCapabilities().defaults }); assert.equal((await f.engine.waitForRun(next.runId)).state, 'completed'); await f.engine.waitForSession('session'); assert.deepEqual(f.original(), original); }
  assert.notDeepEqual(f.context(), context); await f.reopen(); assert.deepEqual(await f.engine.acknowledgeProviderRecovery(decision), { ...receipt, duplicate: true }); assert.equal(f.engine.getProviderRecoveryPreview('session',f.attemptId).status,'acknowledged'); assert.equal(f.engine.store.hasUncertainExecution('workspace'),false); assert.deepEqual(f.original(),original); assert.equal(f.fullReads(),0);
});

test('actual prior completed read tool remains immutable and pending queued work is not resumed by a provider decision', { timeout: 30000 }, async t => {
  const f = await fixture(t, { partial: true, priorRead: true }); await f.reopen();
  const completed = f.reader.prepare('SELECT data FROM tools WHERE run_id=? ORDER BY ordinal LIMIT 4').all(f.runId).map(row => JSON.parse(String(row.data))); assert.equal(completed.length,1); assert.equal(completed[0]!.state,'completed');
  const original=f.original(), context=f.context(), controls=['session','other-session'].map(id=>f.engine.store.getSessionControl(id));
  const queued=f.engine.scheduler.accept({sessionId:'other-session',requestId:'existing-backlog',prompt:'Explicit future task',config:f.engine.getCapabilities().defaults,delivery:'queue'}), decision=request(f);
  const receipt=await f.engine.acknowledgeProviderRecovery(decision); await f.engine.waitForSession('other-session'); await tick();
  assert.equal(receipt.executionResumed,false); assert.deepEqual(f.original(),original); assert.deepEqual(f.context(),context); assert.deepEqual(['session','other-session'].map(id=>f.engine.store.getSessionControl(id)),controls); assert.equal(f.engine.store.getInput(queued.inputId).state,'pending'); assert.equal(f.observed.length,2); assert.equal(f.fullReads(),0);
});

test('actual promoted steering remains exact provider recovery evidence and cannot be replaced by a changed user message',{timeout:30000},async t=>{
  const f=await fixture(t,{priorRead:true,steer:true});assert.ok(f.steerId);assert.equal(f.engine.store.getInput(f.steerId).state,'promoted');
  assert.ok(f.observed.at(-1)!.request.messages.some(message=>message.role==='user'&&message.content===goal+' Exact promoted steering constraint.'));
  await f.reopen();const decision=request(f),original=f.original();assert.equal(f.engine.store.getTurn(f.turnId).inputIds.includes(f.steerId),true);
  const writer=new DatabaseSync(f.dbPath);try{writer.prepare("UPDATE messages SET data=json_set(data,'$.content','Synthetic changed promoted steering constraint.') WHERE id=?").run(f.steerId);}finally{writer.close();}
  const preview=f.engine.getProviderRecoveryPreview('session',f.attemptId);assert.equal(preview.status,'blocked',JSON.stringify(preview));assert.ok(preview.blockers.includes('PROVIDER_RECOVERY_SOURCE_CHANGED'));await assert.rejects(f.engine.acknowledgeProviderRecovery(decision));assert.equal(f.rows(),0);assert.notDeepEqual(f.original(),original);assert.equal(f.observed.length,2);blocked(f);assert.equal(f.fullReads(),0);
});

test('actual cancel and consumer protocol failures with known cleanup have no unknown provider outcome to acknowledge', { timeout: 30000 }, async t => {
  for (const failure of ['cancel','protocol'] as const) {
    const f=await fixture(t,{failure}); await f.reopen(); const original=f.original();
    assert.equal(f.engine.getAttemptCleanup('session',f.attemptId).cleanupConfirmed,true); assert.equal(f.engine.store.getAttempt(f.attemptId).state,failure==='cancel'?'interrupted':'failed');
    const preview=f.engine.getProviderRecoveryPreview('session',f.attemptId); assert.equal(preview.status,'blocked'); assert.ok(preview.blockers.includes('PROVIDER_RECOVERY_NOT_NEEDED'));
    await assert.rejects(f.engine.acknowledgeProviderRecovery({sessionId:'session',attemptId:f.attemptId,requestId:'not-unknown',fingerprint:'0'.repeat(64),acknowledged:true})); assert.equal(f.rows(),0); assert.deepEqual(f.original(),original); assert.equal(f.observed.length,1); assert.equal(f.fullReads(),0);
  }
});

test('actual provider recovery validates host decisions, owner and mutable context before publication', { timeout: 30000 }, async t => {
  const f=await fixture(t); await f.reopen(); const decision=request(f), original=f.original(); let reads=0;
  assert.throws(()=>f.engine.getProviderRecoveryPreview('other-session',f.attemptId),code('PROVIDER_RECOVERY_OWNER_MISMATCH'));
  await assert.rejects(f.engine.acknowledgeProviderRecovery({...decision,sessionId:'other-session'}),code('PROVIDER_RECOVERY_OWNER_MISMATCH'));
  await assert.rejects(f.engine.acknowledgeProviderRecovery({...decision,acknowledged:false} as unknown as ProviderRecoveryRequest),code('PROVIDER_RECOVERY_ACKNOWLEDGMENT_REQUIRED'));
  const accessor={...decision}; Object.defineProperty(accessor,'fingerprint',{enumerable:true,get(){reads++;throw new Error('Host accessor must not run');}});
  const proxy=new Proxy({...decision},{get(){reads++;throw new Error('Host proxy must not run');},ownKeys(){reads++;throw new Error('Host proxy must not enumerate');}});
  for(const invalid of [null,[],accessor,proxy,{...decision,extra:true},{...decision,requestId:'x'.repeat(257)},{...decision,fingerprint:'G'.repeat(64)}]) await assert.rejects(f.engine.acknowledgeProviderRecovery(invalid as unknown as ProviderRecoveryRequest),code('PROVIDER_RECOVERY_INVALID_REQUEST'));
  assert.equal(reads,0); assert.equal(f.rows(),0);
  const head=f.engine.store.getSessionDocument('session','context.head')!; f.engine.store.putSessionDocument('session','context.head',head.revision,{...head.data,fixtureObservation:true});
  assert.notEqual(f.engine.getProviderRecoveryPreview('session',f.attemptId).fingerprint,decision.fingerprint); await assert.rejects(f.engine.acknowledgeProviderRecovery(decision),code('PROVIDER_RECOVERY_STALE')); assert.equal(f.rows(),0); assert.deepEqual(f.original(),original);
  const detached=request(f), mutable={...detached}, pending=f.engine.acknowledgeProviderRecovery(mutable); mutable.sessionId='missing';mutable.attemptId='missing';mutable.fingerprint='f'.repeat(64);mutable.requestId='mutated';
  const receipt=await pending; assert.equal(receipt.attemptId,detached.attemptId);assert.equal(receipt.fingerprint,detached.fingerprint);assert.equal(receipt.requestId,detached.requestId);assert.deepEqual(f.original(),original);assert.equal(f.fullReads(),0);
});

test('actual immutable provider receipt can be read during maintenance or unrelated quarantine but never clears new-work guards', { timeout: 30000 }, async t => {
  const f=await fixture(t);await f.reopen();f.engine.scheduler.pause('other-session');
  const queued=f.engine.scheduler.accept({sessionId:'other-session',requestId:'paused-backlog',prompt:'Explicit future task',config:f.engine.getCapabilities().defaults,delivery:'queue'});await f.engine.waitForSession('other-session');
  const decision=request(f), receipt=await f.engine.acknowledgeProviderRecovery(decision), original=f.original(),context=f.context(),controls=['session','other-session'].map(id=>f.engine.store.getSessionControl(id)),input=f.engine.store.getInput(queued.inputId),entered=deferred(),release=deferred();
  const lease=f.engine.coordinator.withWorkspaceLease('workspace',async()=>{entered.resolve();await release.promise;return{cleanupConfirmed:true};});
  try{await entered.promise;assert.deepEqual(await f.engine.acknowledgeProviderRecovery(decision),{...receipt,duplicate:true});await assert.rejects(f.engine.acknowledgeProviderRecovery({...decision,fingerprint:'f'.repeat(64)}),code('PROVIDER_RECOVERY_REQUEST_CONFLICT'));await assert.rejects(f.engine.acknowledgeProviderRecovery({...decision,requestId:'new-busy'}),code('WORKSPACE_BUSY'));}finally{release.resolve();await lease;}
  f.engine.coordinator.quarantineWorkspace('workspace');assert.deepEqual(await f.engine.acknowledgeProviderRecovery(decision),{...receipt,duplicate:true});await assert.rejects(f.engine.acknowledgeProviderRecovery({...decision,fingerprint:'f'.repeat(64)}),code('PROVIDER_RECOVERY_REQUEST_CONFLICT'));await assert.rejects(f.engine.acknowledgeProviderRecovery({...decision,requestId:'new-quarantined'}),code('CLEANUP_PENDING'));blocked(f);
  assert.deepEqual(f.original(),original);assert.deepEqual(f.context(),context);assert.deepEqual(['session','other-session'].map(id=>f.engine.store.getSessionControl(id)),controls);assert.deepEqual(f.engine.store.getInput(queued.inputId),input);assert.equal(f.rows(),1);assert.equal(count(f,'events','provider.recovery.acknowledged'),1);assert.equal(count(f,'session_events','provider.recovery.acknowledged'),1);assert.equal(f.observed.length,1);assert.equal(f.fullReads(),0);
});

for(const journal of ['events','session_events'] as const)test(`actual ${journal} provider ACK failure rolls back ledger and both audit journals`,{timeout:30000},async t=>{
  const f=await fixture(t);await f.reopen();const decision=request(f),original=f.original(),context=f.context(),control=f.engine.store.getSessionControl('session'),writer=new DatabaseSync(f.dbPath);
  try{writer.exec(`CREATE TRIGGER reject_provider_ack BEFORE INSERT ON ${journal} WHEN NEW.type='provider.recovery.acknowledged' BEGIN SELECT RAISE(ABORT,'synthetic provider audit rejected'); END`);await assert.rejects(f.engine.acknowledgeProviderRecovery(decision));assert.equal(f.rows(),0);assert.equal(count(f,'events','provider.recovery.acknowledged'),0);assert.equal(count(f,'session_events','provider.recovery.acknowledged'),0);assert.deepEqual(f.original(),original);assert.deepEqual(f.context(),context);assert.deepEqual(f.engine.store.getSessionControl('session'),control);assert.equal(f.engine.store.hasUncertainExecution('workspace'),true);writer.exec('DROP TRIGGER reject_provider_ack');}finally{writer.close();}
  await f.reopen();assert.equal(f.engine.getProviderRecoveryPreview('session',f.attemptId).status,'eligible');assert.equal(f.rows(),0);assert.equal(f.observed.length,1);assert.equal(f.fullReads(),0);
});

for(const mutation of ['missing-cleanup','cleanup-hash','usage','source','native-owner','effect-origin'] as const)test(`actual provider recovery fails closed on ${mutation} evidence drift`,{timeout:30000},async t=>{
  const f=await fixture(t,{partial:true});await f.reopen();const decision=request(f),writer=new DatabaseSync(f.dbPath);
  try{
    if(mutation==='missing-cleanup')writer.prepare('DELETE FROM attempt_cleanup WHERE attempt_id=?').run(f.attemptId);
    if(mutation==='cleanup-hash')writer.prepare("UPDATE attempt_cleanup SET data=json_set(data,'$.requestSha256',?) WHERE attempt_id=?").run('f'.repeat(64),f.attemptId);
    if(mutation==='usage')writer.prepare("UPDATE attempt_usage SET data=json_set(data,'$.usage.inputTokens',22) WHERE attempt_id=?").run(f.attemptId);
    if(mutation==='source')writer.prepare("UPDATE messages SET data=json_set(data,'$.content','Synthetic altered original goal.') WHERE run_id=? AND json_extract(data,'$.role')='user'").run(f.runId);
    if(mutation==='native-owner')writer.prepare("UPDATE provider_attempts SET data=json_set(data,'$.sessionId','other-session') WHERE id=?").run(f.attemptId);
    if(mutation==='effect-origin')writer.prepare("UPDATE session_turns SET data=json_set(data,'$.uncertainty.kind','tool_effect') WHERE id=?").run(f.turnId);
  }finally{writer.close();}
  const preview=f.engine.getProviderRecoveryPreview('session',f.attemptId);
  if(mutation==='usage')assert.notEqual(preview.fingerprint,decision.fingerprint);else assert.equal(preview.status,'blocked',JSON.stringify(preview));
  await assert.rejects(f.engine.acknowledgeProviderRecovery(decision));assert.equal(f.rows(),0);blocked(f);assert.equal(f.observed.length,1);assert.equal(f.fullReads(),0);
});

for(const cleanup of ['missing','rejected','not-done'] as const)test(`actual unknown ${cleanup} cleanup is never eligible for outcome-only recovery`,{timeout:30000},async t=>{
  const f=await fixture(t,{cleanup});await f.reopen();assert.equal(f.engine.getAttemptCleanup('session',f.attemptId).cleanupConfirmed,false);assert.equal(f.engine.getProviderRecoveryPreview('session',f.attemptId).status,'blocked');await assert.rejects(f.engine.acknowledgeProviderRecovery({sessionId:'session',attemptId:f.attemptId,requestId:'unknown-cleanup',fingerprint:'0'.repeat(64),acknowledged:true}));assert.equal(f.rows(),0);blocked(f);assert.equal(f.fullReads(),0);
});

test('actual provider host decision cannot bypass an independent effect lock, quarantine or persisted active Run',{timeout:30000},async t=>{
  const f=await fixture(t);await f.reopen();const original=f.original(),decision=request(f);f.engine.coordinator.quarantineWorkspace('workspace');await assert.rejects(f.engine.acknowledgeProviderRecovery(decision),code('CLEANUP_PENDING'));await f.reopen();
  const lock=acquireExecutionLock(f.dbPath+'.effects.sqlite');try{await assert.rejects(f.engine.acknowledgeProviderRecovery(request(f)));assert.equal(f.rows(),0);}finally{lock.release(true);}
  const current=request(f),active=f.engine.store.admit({sessionId:'other-session',requestId:'independent-active',prompt:'Independent persisted active Run',config:f.engine.getCapabilities().defaults});assert.equal(f.engine.store.getRun(active.runId).state,'created');await assert.rejects(f.engine.acknowledgeProviderRecovery(current),code('WORKSPACE_BUSY'));assert.equal(f.rows(),0);assert.deepEqual(f.original(),original);assert.equal(f.observed.length,1);assert.equal(f.fullReads(),0);
});

test('actual DB7 archive retains historical provider ACK but import requires a fresh physical binding decision',{timeout:30000},async t=>{
  const f=await fixture(t,{partial:true});await f.reopen();const decision=request(f),receipt=await f.engine.acknowledgeProviderRecovery(decision),original=f.original(),ledger=f.reader.prepare('SELECT data FROM provider_recovery_acknowledgments WHERE id=?').get(receipt.id)!;await f.engine.close();
  const archive=await exportEngineArchive({dbPath:f.dbPath,artifactDir:f.artifactDir,destination:join(f.root,'archive')});assert.equal(archive.manifest.databases.find(database=>database.role==='primary')!.schemaVersion,DB_VERSION);
  const imported=await importEngineArchive({directory:archive.directory,destination:join(f.root,'restored')});assert.equal(imported.executionResumed,false);const restored=construct({...f.options,dbPath:imported.dbPath,artifactDir:imported.artifactDir},()=>assert.fail('Imported recovery cannot read whole snapshots'));t.after(()=>restored.close());
  const read=new DatabaseSync(imported.dbPath,{readOnly:true});t.after(()=>read.close());assert.deepEqual(read.prepare('SELECT data FROM provider_recovery_acknowledgments WHERE id=?').get(receipt.id),ledger);assert.equal(restored.store.hasUncertainExecution('workspace'),true);
  const preview=restored.getProviderRecoveryPreview('session',f.attemptId);assert.equal(preview.status,'eligible',JSON.stringify(preview));assert.notEqual(preview.bindingScope,receipt.bindingScope);assert.notEqual(preview.fingerprint,decision.fingerprint);await assert.rejects(restored.acknowledgeProviderRecovery(decision));
  const next=await restored.acknowledgeProviderRecovery({...decision,requestId:'fresh-imported-host-decision',fingerprint:preview.fingerprint!});assert.equal(next.providerOutcomeConfirmed,false);assert.equal(restored.store.hasUncertainExecution('workspace'),false);assert.equal(f.observed.length,1);assert.deepEqual(f.original(),original);assert.equal(f.fullReads(),0);
});

test('actual new uncertain outcome after a prior host decision requires its own restart and exact decision',{timeout:30000},async t=>{
  const f=await fixture(t);await f.reopen();const first=request(f),receipt=await f.engine.acknowledgeProviderRecovery(first),original=f.original();
  const second=f.engine.coordinator.submit({sessionId:'other-session',requestId:'new-unknown',prompt:goal,config:f.engine.getCapabilities().defaults});assert.equal((await f.engine.waitForRun(second.runId)).error?.code,'PROVIDER_TRANSPORT_ERROR');await f.engine.waitForSession('other-session');
  const attemptId=f.observed.at(-1)!.request.attemptId!,sameBoot=f.engine.getProviderRecoveryPreview('other-session',attemptId);assert.equal(sameBoot.status,'blocked');assert.ok(sameBoot.blockers.includes('PROVIDER_RECOVERY_RESTART_REQUIRED'));blocked(f);
  await assert.rejects(f.engine.acknowledgeProviderRecovery({...first,sessionId:'other-session',attemptId}),code('PROVIDER_RECOVERY_REQUEST_CONFLICT'));
  assert.deepEqual(await f.engine.acknowledgeProviderRecovery(first),{...receipt,duplicate:true});assert.equal(f.rows(),1);assert.equal(f.engine.store.hasUncertainExecution('workspace'),true);assert.deepEqual(f.original(),original);
  await f.reopen();const preview=f.engine.getProviderRecoveryPreview('other-session',attemptId);assert.equal(preview.status,'eligible',JSON.stringify(preview));
  assert.equal(f.engine.getProviderRecoveryPreview('session',f.attemptId).status,'acknowledged');assert.equal(f.engine.store.hasUncertainExecution('workspace'),true);
  await f.engine.acknowledgeProviderRecovery({sessionId:'other-session',attemptId,requestId:'second-exact-host-decision',fingerprint:preview.fingerprint!,acknowledged:true});assert.equal(f.rows(),2);assert.equal(f.engine.store.hasUncertainExecution('workspace'),false);assert.deepEqual(f.original(),original);assert.equal(f.observed.length,2);assert.equal(f.fullReads(),0);
});

test('actual independent summary uncertainty remains quarantined after an ordinary provider outcome was acknowledged',{timeout:30000},async t=>{
  const f=await fixture(t,{independentSummary:true});await f.reopen();const decision=request(f),receipt=await f.engine.acknowledgeProviderRecovery(decision),original=f.original();
  const config=f.engine.getCapabilities().defaults,historical=f.engine.coordinator.submit({sessionId:'other-session',requestId:'summary-history',prompt:'Synthetic history for an independent summary.',config});assert.equal((await f.engine.waitForRun(historical.runId)).state,'completed');await f.engine.waitForSession('other-session');
  const next=f.engine.coordinator.submit({sessionId:'other-session',requestId:'summary-current',prompt:'Keep the exact current constraint. '.repeat(240),config:{...config,limits:{...config.limits,maxContextBytes:16384}}});assert.equal((await f.engine.waitForRun(next.runId)).error?.code,'CLEANUP_UNCERTAIN');await f.engine.waitForSession('other-session');
  assert.equal(f.observed.at(-1)!.request.tools.length,0);assert.equal(f.engine.store.hasUncertainSummaries('workspace'),true);assert.equal(f.engine.getProviderRecoveryPreview('session',f.attemptId).status,'acknowledged');assert.deepEqual(await f.engine.acknowledgeProviderRecovery(decision),{...receipt,duplicate:true});blocked(f);
  assert.equal(f.rows(),1);assert.deepEqual(f.original(),original);const calls=f.observed.length;await f.reopen();assert.equal(f.engine.store.hasUncertainSummaries('workspace'),true);blocked(f);assert.equal(f.observed.length,calls);assert.deepEqual(f.original(),original);assert.equal(f.fullReads(),0);
});

test('actual acknowledged provider evidence remains blocked if an immutable context pin or receipt is altered',{timeout:30000},async t=>{
  for(const mutation of ['pin','receipt'] as const){
    const f=await fixture(t);await f.reopen();const decision=request(f),receipt=await f.engine.acknowledgeProviderRecovery(decision);assert.equal(f.engine.store.hasUncertainExecution('workspace'),false);
    const writer=new DatabaseSync(f.dbPath);try{
      if(mutation==='pin'){const revisionId=f.engine.store.getAttempt(f.attemptId).contextRevisionId!;writer.prepare("UPDATE context_revisions SET data=json_set(data,'$.text','Synthetic altered immutable context revision.') WHERE id=?").run(revisionId);}
      else writer.prepare("UPDATE provider_recovery_acknowledgments SET data=json_set(data,'$.receipt.providerOutcomeConfirmed',json('true')) WHERE id=?").run(receipt.id);
    }finally{writer.close();}
    assert.equal(f.engine.store.hasUncertainExecution('workspace'),true);blocked(f);assert.equal(f.rows(),1);assert.equal(f.observed.length,1);assert.equal(f.fullReads(),0);
  }
});

for(const phase of ['before-commit','after-commit','attempt-settled'] as const)test(`actual owned SIGKILL at provider ${phase} preserves evidence and never autonomously repeats provider work`,{timeout:30000,skip:process.platform==='win32'},async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'moodcode-provider-recovery-crash-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=import.meta.url.endsWith('.ts'),extension=source?'ts':import.meta.url.endsWith('.mjs')?'mjs':'js',path=fileURLToPath(new URL(`./fixtures/provider-recovery-child.${extension}`,import.meta.url));
  const child=spawn(process.execPath,[...(source?['--import','tsx']:[]),path,root,phase],{stdio:['ignore','ignore','pipe','ipc']});let diagnostics='';child.stderr?.on('data',chunk=>{diagnostics=(diagnostics+String(chunk)).slice(-8192);});
  const exited=new Promise<void>(resolve=>child.once('close',()=>resolve()));t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
  const ready=await new Promise<{phase:string;runId:string;attemptId:string;turnId:string;request?:ProviderRecoveryRequest}>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`Provider child missed ${phase}: ${diagnostics}`)),12000);child.once('message',message=>{clearTimeout(timer);resolve(message as Awaited<typeof ready>);});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(new Error(`Provider child exited before ${phase}: ${diagnostics}`));});
  });assert.equal(ready.phase,phase);
  const dbPath=join(root,'engine.sqlite'),artifactDir=join(root,'artifacts'),reader=new DatabaseSync(dbPath,{readOnly:true});t.after(()=>reader.close());
  const get=(table:string,key:string,id:string)=>JSON.parse(String(reader.prepare(`SELECT data FROM ${table} WHERE ${key}=?`).get(id)!.data));
  const attempt=get('provider_attempts','id',ready.attemptId),proof=get('attempt_cleanup','attempt_id',ready.attemptId),usage=get('attempt_usage','attempt_id',ready.attemptId);assert.equal(attempt.state,'uncertain');assert.equal(proof.state,'confirmed');assert.equal(proof.cleanupConfirmed,true);assert.equal(proof.method,'iterator-return-done');
  assert.equal(Number(reader.prepare('SELECT count(*) AS n FROM provider_recovery_acknowledgments').get()!.n),phase==='after-commit'?1:0);
  for(const journal of ['events','session_events'])assert.equal(Number(reader.prepare(`SELECT count(*) AS n FROM ${journal} WHERE type='provider.recovery.acknowledged'`).get()!.n),phase==='after-commit'?1:0);
  if(phase==='attempt-settled')assert.ok(['created','streaming'].includes(get('session_turns','id',ready.turnId).state));child.kill('SIGKILL');await exited;assert.equal(await readFile(join(root,'provider-calls.log'),'utf8'),'dispatch\n');
  let calls=0,fullReads=0;const provider:ProviderAdapter={id:'provider-recovery-crash',async *streamTurn(){calls++;yield{type:'text.delta',delta:'Explicit new task after crash host decision.'};yield{type:'finish',reason:'stop'};}};
  const options:EngineOptions={dbPath,artifactDir,providers:[provider],allowedToolNames:['read_file'],defaults:{providerId:provider.id,modelId:'fixture-model',mode:'plan',limits:{maxContextBytes:262144,maxOutputBytes:32768}}};let engine=construct(options,()=>fullReads++);t.after(()=>engine.close());
  assert.deepEqual(engine.store.getAttempt(ready.attemptId),attempt);assert.deepEqual(engine.getAttemptCleanup('session',ready.attemptId),proof);assert.deepEqual(get('attempt_usage','attempt_id',ready.attemptId),usage);assert.equal(calls,0);
  const turn=engine.store.getTurn(ready.turnId);assert.equal(turn.state,phase==='attempt-settled'?'interrupted':'uncertain');if(phase==='attempt-settled')assert.equal(turn.uncertainty,undefined);
  const preview=engine.getProviderRecoveryPreview('session',ready.attemptId);assert.equal(preview.status,phase==='after-commit'?'acknowledged':'eligible',JSON.stringify(preview));
  const decision=ready.request??{sessionId:'session',attemptId:ready.attemptId,requestId:'crash-host-decision',fingerprint:preview.fingerprint!,acknowledged:true as const};
  const control=engine.store.getSessionControl('session'),context=['context.head','context.memory','context.active_memory'].map(kind=>engine.store.getSessionDocument('session',kind));
  const receipt=await engine.acknowledgeProviderRecovery(decision);assert.equal(receipt.duplicate,phase==='after-commit');assert.equal(receipt.providerOutcomeConfirmed,false);assert.equal(receipt.providerRetried,false);assert.equal(receipt.executionResumed,false);assert.equal(calls,0);assert.deepEqual(engine.store.getTurn(ready.turnId),turn);assert.deepEqual(engine.store.getSessionControl('session'),control);assert.deepEqual(['context.head','context.memory','context.active_memory'].map(kind=>engine.store.getSessionDocument('session',kind)),context);
  const next=engine.coordinator.submit({sessionId:'session',requestId:'explicit-new-work',prompt:'Explicit independent new task',config:engine.getCapabilities().defaults});assert.equal((await engine.waitForRun(next.runId)).state,'completed');await engine.waitForSession('session');assert.equal(calls,1);
  await engine.close();engine=construct(options,()=>fullReads++);assert.deepEqual(await engine.acknowledgeProviderRecovery(decision),{...receipt,duplicate:true});assert.deepEqual(engine.store.getAttempt(ready.attemptId),attempt);assert.deepEqual(engine.getAttemptCleanup('session',ready.attemptId),proof);assert.deepEqual(engine.store.getTurn(ready.turnId),turn);assert.equal(engine.store.hasUncertainExecution('workspace'),false);assert.equal(calls,1);assert.equal(fullReads,0);
});
