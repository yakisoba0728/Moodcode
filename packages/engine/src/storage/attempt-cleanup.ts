import { EngineError, isTerminal, type EngineEvent, type JsonObject, type ProviderAttempt, type Run, type TurnRecord } from '@moodcode/contracts';
import { validateProviderAttempt, validateTurnRecord } from '@moodcode/contracts/validation';
import { jsonTextSha256 } from '../shared/canonical.js';
import { isBoundedId, isCanonicalStamp, isSha256, parseJsonOr, plainRecord } from '../shared/data.js';
import { NativeSessionStorage } from './native.js';
import { invalidateEvidenceRead, readEvidenceBody } from './evidence-read.js';

export const ATTEMPT_CLEANUP_TABLES = ['attempt_cleanup'] as const;
export const ATTEMPT_CLEANUP_LIMITS = Object.freeze({ maxRecordBytes: 16_384, maxOwnerBytes: 1_048_576, maxRequestBytes: 67_108_864, recoveryPageSize: 100 });
export const ATTEMPT_CLEANUP_SCHEMA = `CREATE TABLE attempt_cleanup (
  attempt_id TEXT PRIMARY KEY REFERENCES provider_attempts(id),
  session_id TEXT NOT NULL REFERENCES sessions(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  run_id TEXT NOT NULL REFERENCES runs(id), turn_id TEXT NOT NULL REFERENCES session_turns(id),
  provider_id TEXT NOT NULL, model_id TEXT NOT NULL, context_revision_id TEXT REFERENCES context_revisions(id),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
  request_bytes INTEGER NOT NULL CHECK(request_bytes BETWEEN 1 AND 67108864),
  state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','confirmed','uncertain','not-dispatched')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=16384)
) STRICT;
CREATE INDEX attempt_cleanup_session ON attempt_cleanup(session_id);
CREATE INDEX attempt_cleanup_run ON attempt_cleanup(run_id);
CREATE INDEX attempt_cleanup_workspace_uncertain ON attempt_cleanup(workspace_id) WHERE state='uncertain';
CREATE INDEX attempt_cleanup_pending ON attempt_cleanup(state) WHERE state IN ('prepared','dispatched');`;

export type AttemptCleanupState = 'prepared' | 'dispatched' | 'confirmed' | 'uncertain' | 'not-dispatched';
export type AttemptCleanupMethod = 'iterator-next-done' | 'iterator-return-done' | 'return-missing' | 'return-rejected' | 'return-timeout' | 'return-not-done' | 'iterator-unavailable' | 'recovery' | 'no-dispatch';
export type AttemptCleanupReason = 'natural-done' | 'error' | 'consumer-close' | 'cancel' | 'restart';
export interface AttemptCleanupIdentity {
  attemptId: string; sessionId: string; workspaceId: string; runId: string; turnId: string; providerId: string; modelId: string; contextRevisionId?: string;
  requestProjection: 'engine-turn-request-v1'; requestSha256: string; requestBytes: number; createdAt?: string;
}
export interface AttemptCleanupSettlement {
  outcome: 'confirmed' | 'uncertain' | 'not-dispatched'; method: AttemptCleanupMethod; reason: AttemptCleanupReason;
  providerRequestId?: string; errorCode?: string;
}
export interface AttemptCleanupRecord extends Omit<AttemptCleanupIdentity, 'createdAt'> {
  schemaVersion: 2; revision: number; state: AttemptCleanupState; cleanupConfirmed: boolean | null;
  createdAt: string; updatedAt: string; dispatchedAt?: string; settledAt?: string;
  method?: AttemptCleanupMethod; reason?: AttemptCleanupReason; providerRequestId?: string; errorCode?: string;
}
type Row = Record<string, unknown>;
const IDENTITY_KEYS = ['attemptId','sessionId','workspaceId','runId','turnId','providerId','modelId','contextRevisionId','requestProjection','requestSha256','requestBytes','createdAt'] as const;
const SETTLEMENT_KEYS = ['outcome','method','reason','providerRequestId','errorCode'] as const;
const RECORD_KEYS = [...IDENTITY_KEYS,'schemaVersion','revision','state','cleanupConfirmed','updatedAt','dispatchedAt','settledAt','method','reason','providerRequestId','errorCode'] as const;
const TERMINAL = new Set<AttemptCleanupState>(['confirmed','uncertain','not-dispatched']);
const METHODS: readonly AttemptCleanupMethod[] = ['iterator-next-done','iterator-return-done','return-missing','return-rejected','return-timeout','return-not-done','iterator-unavailable','recovery','no-dispatch'];
const REASONS: readonly AttemptCleanupReason[] = ['natural-done','error','consumer-close','cancel','restart'];
const now = () => new Date().toISOString();
function fail(code: string, message: string): never { throw new EngineError(code, message); }
function plain(value: unknown, keys: readonly string[]): void {
  plainRecord(value,[],keys,fault=>fail('INVALID_ATTEMPT_CLEANUP',fault==='shape'?'Cleanup records accept plain data only':'Cleanup records reject accessors and unknown fields'));
}
function identity(value: AttemptCleanupIdentity): AttemptCleanupIdentity {
  plain(value,IDENTITY_KEYS);
  for (const key of ['attemptId','sessionId','workspaceId','runId','turnId','providerId','modelId'] as const) if (!isBoundedId(value[key])) fail('INVALID_ATTEMPT_CLEANUP','Cleanup identity is invalid');
  if (value.contextRevisionId !== undefined && !isBoundedId(value.contextRevisionId) || value.requestProjection !== 'engine-turn-request-v1'
    || !isSha256(value.requestSha256) || !Number.isSafeInteger(value.requestBytes)
    || value.requestBytes < 1 || value.requestBytes > ATTEMPT_CLEANUP_LIMITS.maxRequestBytes || value.createdAt !== undefined && !isCanonicalStamp(value.createdAt)) fail('INVALID_ATTEMPT_CLEANUP','Cleanup request or context identity is invalid');
  return structuredClone(value);
}
function settlement(value: AttemptCleanupSettlement): AttemptCleanupSettlement {
  plain(value,SETTLEMENT_KEYS);
  if (!['confirmed','uncertain','not-dispatched'].includes(value.outcome) || !METHODS.includes(value.method) || !REASONS.includes(value.reason)
    || value.providerRequestId !== undefined && !isBoundedId(value.providerRequestId) || value.errorCode !== undefined && !isBoundedId(value.errorCode)) fail('INVALID_ATTEMPT_CLEANUP','Cleanup observation is invalid');
  if (value.outcome === 'confirmed' && !['iterator-next-done','iterator-return-done'].includes(value.method)
    || value.outcome === 'not-dispatched' && value.method !== 'no-dispatch'
    || value.outcome === 'uncertain' && ['iterator-next-done','iterator-return-done','no-dispatch'].includes(value.method)
    || value.method === 'iterator-next-done' && value.reason !== 'natural-done'
    || value.method === 'recovery' && value.reason !== 'restart') fail('INVALID_ATTEMPT_CLEANUP','Cleanup outcome requires its exact observed proof');
  return structuredClone(value);
}
function record(value: AttemptCleanupRecord): void {
  plain(value,RECORD_KEYS);
  identity(Object.fromEntries(IDENTITY_KEYS.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]])) as unknown as AttemptCleanupIdentity);
  if (value.schemaVersion !== 2 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !['prepared','dispatched','confirmed','uncertain','not-dispatched'].includes(value.state)
    || !isCanonicalStamp(value.createdAt) || !isCanonicalStamp(value.updatedAt) || value.dispatchedAt !== undefined && !isCanonicalStamp(value.dispatchedAt) || value.settledAt !== undefined && !isCanonicalStamp(value.settledAt)) fail('INVALID_ATTEMPT_CLEANUP','Stored cleanup state or timestamps are invalid');
  if (TERMINAL.has(value.state)) {
    settlement({outcome:value.state as AttemptCleanupSettlement['outcome'],method:value.method!,reason:value.reason!,...(value.providerRequestId===undefined?{}:{providerRequestId:value.providerRequestId}),...(value.errorCode===undefined?{}:{errorCode:value.errorCode})});
    if (!value.settledAt || value.cleanupConfirmed !== (value.state==='confirmed'?true:value.state==='uncertain'?false:null)
      || value.state==='confirmed' && !value.dispatchedAt || value.state==='not-dispatched' && value.dispatchedAt) fail('INVALID_ATTEMPT_CLEANUP','Stored cleanup evidence is inconsistent');
  } else if (value.cleanupConfirmed !== null || value.settledAt !== undefined || value.method !== undefined || value.reason !== undefined || value.providerRequestId !== undefined || value.errorCode !== undefined
    || (value.state==='dispatched') !== !!value.dispatchedAt) fail('INVALID_ATTEMPT_CLEANUP','Pending cleanup record cannot declare terminal evidence');
  if(value.updatedAt<value.createdAt||value.dispatchedAt!==undefined&&(value.dispatchedAt<value.createdAt||value.dispatchedAt>value.updatedAt)
    ||value.settledAt!==undefined&&(value.settledAt<(value.dispatchedAt??value.createdAt)||value.settledAt!==value.updatedAt))fail('INVALID_ATTEMPT_CLEANUP','Cleanup observation timestamps must preserve their canonical lifecycle order');
}
function canonicalIdentity(value: AttemptCleanupIdentity): string { return JSON.stringify(IDENTITY_KEYS.filter(key=>key!=='createdAt').map(key=>[key,value[key]])); }
function canonicalSettlement(value: AttemptCleanupSettlement): string { return JSON.stringify(SETTLEMENT_KEYS.map(key=>[key,value[key]])); }
function size(value: unknown, cap: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value)>cap) fail('ATTEMPT_CLEANUP_LIMIT','Cleanup evidence exceeds its bounded read budget');
  return Number(value);
}
function parse(value: unknown): unknown {
  return parseJsonOr(String(value),()=>fail('INVALID_ATTEMPT_CLEANUP','Stored cleanup evidence or owner JSON is malformed'));
}
export function canonicalAttemptCleanupSha256(value:AttemptCleanupRecord):string {
  record(value);
  const normalized=Object.fromEntries(Object.keys(value).sort().filter(key=>value[key as keyof AttemptCleanupRecord]!==undefined).map(key=>[key,value[key as keyof AttemptCleanupRecord]]));
  return jsonTextSha256(normalized);
}
function notDispatched(attempt:ProviderAttempt):boolean { return ['prepared','interrupted'].includes(attempt.state)&&attempt.dispatchedAt===undefined&&attempt.providerRequestId===undefined; }

/** Separate cleanup evidence never rewrites ordinary execution outcomes or reconstructs legacy proof. */
export class AttemptCleanupStorage {
  constructor(private readonly native: NativeSessionStorage, private readonly appendLegacy: (run: Run,type: string,payload: JsonObject)=>EngineEvent) {}
  private get db() { return this.native.database; }
  private owner(identityValue: AttemptCleanupIdentity): {run: Run; attempt: ProviderAttempt; turn: TurnRecord} {
    const runHeader=this.db.prepare('SELECT r.id,r.input_id,r.session_id,r.workspace_id,r.state,length(CAST(r.data AS BLOB)) AS bytes,s.workspace_id AS session_workspace_id,length(CAST(s.data AS BLOB)) AS session_bytes,w.id AS workspace_id_check,length(CAST(w.data AS BLOB)) AS workspace_bytes FROM runs r JOIN sessions s ON s.id=r.session_id JOIN workspaces w ON w.id=r.workspace_id WHERE r.id=?').get(identityValue.runId);
    if(!runHeader||runHeader.id!==identityValue.runId||runHeader.session_id!==identityValue.sessionId||runHeader.workspace_id!==identityValue.workspaceId||runHeader.session_workspace_id!==identityValue.workspaceId||runHeader.workspace_id_check!==identityValue.workspaceId)fail('ATTEMPT_CLEANUP_BINDING_MISMATCH','Cleanup Run, session and workspace owners do not match');
    size(runHeader.bytes,ATTEMPT_CLEANUP_LIMITS.maxOwnerBytes);size(runHeader.session_bytes,ATTEMPT_CLEANUP_LIMITS.maxOwnerBytes);size(runHeader.workspace_bytes,ATTEMPT_CLEANUP_LIMITS.maxOwnerBytes);
    const run=this.native.scopeRun(identityValue.sessionId,identityValue.runId);
    const session=parse(readEvidenceBody(this.db,{table:'sessions',key:identityValue.sessionId},{expectedBytes:Number(runHeader.session_bytes),maxBytes:ATTEMPT_CLEANUP_LIMITS.maxOwnerBytes})) as {id?:unknown;workspaceId?:unknown};
    const workspace=parse(readEvidenceBody(this.db,{table:'workspaces',key:identityValue.workspaceId},{expectedBytes:Number(runHeader.workspace_bytes),maxBytes:ATTEMPT_CLEANUP_LIMITS.maxOwnerBytes})) as {id?:unknown};
    if (!run||run.id!==identityValue.runId||run.sessionId!==identityValue.sessionId||run.inputId!==runHeader.input_id||run.state!==runHeader.state||run.workspaceId!==identityValue.workspaceId
      ||run.config?.providerId!==identityValue.providerId || run.config?.modelId!==identityValue.modelId||session?.id!==identityValue.sessionId||session.workspaceId!==identityValue.workspaceId||workspace?.id!==identityValue.workspaceId) fail('ATTEMPT_CLEANUP_BINDING_MISMATCH','Cleanup provider, Run payload or workspace does not match its SQL owner');
    const attemptHeader=this.db.prepare('SELECT session_id,run_id,turn_id,attempt_index,state,length(CAST(data AS BLOB)) AS bytes FROM provider_attempts WHERE id=?').get(identityValue.attemptId);
    const turnHeader=this.db.prepare('SELECT session_id,run_id,turn_index,state,length(CAST(data AS BLOB)) AS bytes FROM session_turns WHERE id=?').get(identityValue.turnId);
    if (!attemptHeader || !turnHeader || attemptHeader.session_id!==identityValue.sessionId || attemptHeader.run_id!==identityValue.runId || attemptHeader.turn_id!==identityValue.turnId
      || turnHeader.session_id!==identityValue.sessionId || turnHeader.run_id!==identityValue.runId) fail('ATTEMPT_CLEANUP_BINDING_MISMATCH','Cleanup Attempt and Turn owners do not match');
    size(attemptHeader.bytes,ATTEMPT_CLEANUP_LIMITS.maxOwnerBytes);size(turnHeader.bytes,ATTEMPT_CLEANUP_LIMITS.maxOwnerBytes);
    const attempt=validateProviderAttempt(parse(readEvidenceBody(this.db,{table:'provider_attempts',key:identityValue.attemptId},{expectedBytes:Number(attemptHeader.bytes),maxBytes:ATTEMPT_CLEANUP_LIMITS.maxOwnerBytes})));
    const turn=validateTurnRecord(parse(readEvidenceBody(this.db,{table:'session_turns',key:identityValue.turnId},{expectedBytes:Number(turnHeader.bytes),maxBytes:ATTEMPT_CLEANUP_LIMITS.maxOwnerBytes})));
    if (attempt.id!==identityValue.attemptId || attempt.sessionId!==identityValue.sessionId || attempt.runId!==identityValue.runId || attempt.turnId!==identityValue.turnId || attempt.state!==attemptHeader.state
      || attempt.providerId!==identityValue.providerId || attempt.modelId!==identityValue.modelId || attempt.contextRevisionId!==identityValue.contextRevisionId || attempt.index!==attemptHeader.attempt_index
      || turn.id!==identityValue.turnId || turn.sessionId!==identityValue.sessionId || turn.runId!==identityValue.runId || turn.state!==turnHeader.state || turn.index!==turnHeader.turn_index) fail('ATTEMPT_CLEANUP_BINDING_MISMATCH','Cleanup payload disagrees with its immutable owner');
    if (identityValue.contextRevisionId) {
      const context=this.db.prepare('SELECT id,session_id,run_id,turn_id,length(CAST(data AS BLOB)) AS bytes FROM context_revisions WHERE id=?').get(identityValue.contextRevisionId);
      if (!context || context.id!==identityValue.contextRevisionId||context.session_id!==identityValue.sessionId || context.run_id!==null && context.run_id!==identityValue.runId || context.turn_id!==null && context.turn_id!==identityValue.turnId) fail('ATTEMPT_CLEANUP_BINDING_MISMATCH','Cleanup context revision belongs to another owner');
      size(context.bytes,1_048_576);
      const facts=this.db.prepare("SELECT json_extract(data,'$.id') AS id,json_extract(data,'$.sessionId') AS session_id,json_extract(data,'$.runId') AS run_id,json_extract(data,'$.turnId') AS turn_id FROM context_revisions WHERE id=?").get(identityValue.contextRevisionId)!;
      if(facts.id!==context.id||facts.session_id!==context.session_id||facts.run_id!==context.run_id||facts.turn_id!==context.turn_id)fail('ATTEMPT_CLEANUP_BINDING_MISMATCH','Cleanup context payload disagrees with its SQL owner');
    }
    return {run,attempt,turn};
  }
  private read(id: string,expectedSessionId?: string): {value: AttemptCleanupRecord;run: Run;attempt: ProviderAttempt;turn: TurnRecord} {
    this.native.hooks.assertOpen();
    if (!isBoundedId(id) || expectedSessionId!==undefined && !isBoundedId(expectedSessionId)) fail('INVALID_ATTEMPT_CLEANUP','Cleanup lookup requires bounded identities');
    const header=this.db.prepare('SELECT attempt_id,session_id,workspace_id,run_id,turn_id,provider_id,model_id,context_revision_id,request_sha256,request_bytes,state,CAST(revision AS TEXT) AS revision,length(CAST(data AS BLOB)) AS bytes FROM attempt_cleanup WHERE attempt_id=?').get(id);
    if (!header) fail('ATTEMPT_CLEANUP_NOT_FOUND','Cleanup evidence was not recorded for this attempt');
    if (expectedSessionId!==undefined && header.session_id!==expectedSessionId) fail('ATTEMPT_CLEANUP_BINDING_MISMATCH','Cleanup evidence belongs to another session');
    size(header.bytes,ATTEMPT_CLEANUP_LIMITS.maxRecordBytes);
    const revision=Number(header.revision);if (!Number.isSafeInteger(revision)||revision<1) fail('INVALID_ATTEMPT_CLEANUP','Stored cleanup revision is invalid');
    const headerIdentity:AttemptCleanupIdentity={attemptId:String(header.attempt_id),sessionId:String(header.session_id),workspaceId:String(header.workspace_id),runId:String(header.run_id),turnId:String(header.turn_id),providerId:String(header.provider_id),modelId:String(header.model_id),
      requestProjection:'engine-turn-request-v1',requestSha256:String(header.request_sha256),requestBytes:Number(header.request_bytes),...(header.context_revision_id===null?{}:{contextRevisionId:String(header.context_revision_id)})};
    identity(headerIdentity);
    const owner=this.owner(headerIdentity);
    const value=parse(readEvidenceBody(this.db,{table:'attempt_cleanup',key:id},{expectedBytes:Number(header.bytes),maxBytes:ATTEMPT_CLEANUP_LIMITS.maxRecordBytes})) as AttemptCleanupRecord;
    record(value);
    if (canonicalIdentity(value)!==canonicalIdentity(headerIdentity) || value.state!==header.state || value.revision!==revision) fail('ATTEMPT_CLEANUP_BINDING_MISMATCH','Cleanup payload and SQL metadata disagree');
    return {value,...owner};
  }
  get(id: string,expectedSessionId?: string): AttemptCleanupRecord { return this.read(id,expectedSessionId).value; }
  private save(value: AttemptCleanupRecord,run: Run): AttemptCleanupRecord {
    record(value);const data=JSON.stringify(value);if(Buffer.byteLength(data)>ATTEMPT_CLEANUP_LIMITS.maxRecordBytes)fail('ATTEMPT_CLEANUP_LIMIT','Cleanup evidence exceeds its storage budget');
    invalidateEvidenceRead(this.db);
    this.db.prepare('INSERT INTO attempt_cleanup(attempt_id,session_id,workspace_id,run_id,turn_id,provider_id,model_id,context_revision_id,request_sha256,request_bytes,state,revision,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET state=excluded.state,revision=excluded.revision,data=excluded.data')
      .run(value.attemptId,value.sessionId,value.workspaceId,value.runId,value.turnId,value.providerId,value.modelId,value.contextRevisionId??null,value.requestSha256,value.requestBytes,value.state,value.revision,data);
    const type=`provider.cleanup.${value.state.replaceAll('-','_')}`,payload={cleanup:JSON.parse(data) as JsonObject};
    this.native.appendEvent(value.sessionId,type,payload,{runId:value.runId,turnId:value.turnId,attemptId:value.attemptId});
    this.appendLegacy(run,type,payload);
    return value;
  }
  create(supplied: AttemptCleanupIdentity): AttemptCleanupRecord {
    const input=identity(supplied);
    return this.native.write(input.sessionId,()=>{
      const existing=this.db.prepare('SELECT attempt_id FROM attempt_cleanup WHERE attempt_id=?').get(input.attemptId);
      if(existing) {
        const previous=this.get(input.attemptId,input.sessionId);
        if(canonicalIdentity(previous)!==canonicalIdentity(input)||input.createdAt!==undefined&&previous.createdAt!==input.createdAt)fail('ATTEMPT_CLEANUP_IDENTITY_CONFLICT','Attempt already owns different cleanup request evidence');
        return previous;
      }
      const {run,attempt,turn}=this.owner(input);
      if(isTerminal(run.state)||['completed','failed','interrupted','uncertain'].includes(turn.state)||attempt.state!=='prepared')fail('ATTEMPT_CLEANUP_TRANSITION_INVALID','Cleanup preparation requires a live prepared ordinary attempt');
      const createdAt=input.createdAt??now();
      return this.save({...input,schemaVersion:2,revision:1,state:'prepared',cleanupConfirmed:null,createdAt,updatedAt:createdAt},run);
    });
  }
  private update(id:string,operation:(value:AttemptCleanupRecord,run:Run,attempt:ProviderAttempt,turn:TurnRecord)=>AttemptCleanupRecord):AttemptCleanupRecord {
    this.native.hooks.assertOpen();
    // Owner metadata is enough to select the transaction notification; the full
    // validated read happens once inside the transaction.
    if(!isBoundedId(id))fail('INVALID_ATTEMPT_CLEANUP','Cleanup lookup requires a bounded attempt identity');
    const header=this.db.prepare('SELECT session_id FROM attempt_cleanup WHERE attempt_id=?').get(id);
    if(!header)fail('ATTEMPT_CLEANUP_NOT_FOUND','Cleanup evidence was not recorded for this attempt');
    return this.native.write(String(header.session_id),()=>{const {value,run,attempt,turn}=this.read(id);return operation(value,run,attempt,turn);});
  }
  dispatch(id:string):AttemptCleanupRecord {
    return this.update(id,(value,run,attempt,turn)=>{
      if(value.state!=='prepared'||isTerminal(run.state)||['completed','failed','interrupted','uncertain'].includes(turn.state)||!['prepared','dispatched'].includes(attempt.state))fail('ATTEMPT_CLEANUP_TRANSITION_INVALID','Provider dispatch requires a live prepared cleanup intent');
      if(value.revision===Number.MAX_SAFE_INTEGER)fail('SEQUENCE_EXHAUSTED','Cleanup revision exceeded the safe integer range');
      const time=now();return this.save({...value,state:'dispatched',revision:value.revision+1,dispatchedAt:time,updatedAt:time},run);
    });
  }
  settle(id:string,supplied:AttemptCleanupSettlement):AttemptCleanupRecord {
    const outcome=settlement(supplied);
    return this.update(id,(value,run,attempt)=>this.settleInTransaction(value,run,attempt,outcome));
  }
  private settleInTransaction(value:AttemptCleanupRecord,run:Run,attempt:ProviderAttempt,outcome:AttemptCleanupSettlement):AttemptCleanupRecord {
    if(TERMINAL.has(value.state)) {
      const previous:AttemptCleanupSettlement={outcome:value.state as AttemptCleanupSettlement['outcome'],method:value.method!,reason:value.reason!,...(value.providerRequestId===undefined?{}:{providerRequestId:value.providerRequestId}),...(value.errorCode===undefined?{}:{errorCode:value.errorCode})};
      if(canonicalSettlement(previous)!==canonicalSettlement(outcome))fail('ATTEMPT_CLEANUP_IMMUTABLE','Terminal cleanup observations cannot be changed');
      return value;
    }
    if(outcome.providerRequestId!==undefined&&attempt.providerRequestId!==outcome.providerRequestId)fail('ATTEMPT_CLEANUP_BINDING_MISMATCH','Observed provider request does not match its ordinary attempt');
    if(outcome.outcome==='not-dispatched'&&(value.state!=='prepared'||!notDispatched(attempt))
      ||outcome.outcome==='confirmed'&&value.state!=='dispatched')fail('ATTEMPT_CLEANUP_TRANSITION_INVALID','Cleanup proof disagrees with the recorded dispatch frontier');
    if(value.revision===Number.MAX_SAFE_INTEGER)fail('SEQUENCE_EXHAUSTED','Cleanup revision exceeded the safe integer range');
    const {outcome:state,...observation}=outcome,time=now();
    return this.save({...value,...observation,state,revision:value.revision+1,cleanupConfirmed:state==='confirmed'?true:state==='uncertain'?false:null,settledAt:time,updatedAt:time},run);
  }
  recoverInTransaction(sessions:Set<string>):void {
    if(!this.db.isTransaction)fail('STORAGE_TRANSACTION_REQUIRED','Cleanup recovery requires the primary startup transaction');
    while(true) {
      const rows=this.db.prepare("SELECT attempt_id FROM attempt_cleanup WHERE state IN ('prepared','dispatched') ORDER BY rowid LIMIT ?").all(ATTEMPT_CLEANUP_LIMITS.recoveryPageSize);
      if(!rows.length)return;
      for(const row of rows) {
        const {value,run,attempt}=this.read(String(row.attempt_id));
        const noDispatch=value.state==='prepared'&&notDispatched(attempt);
        this.settleInTransaction(value,run,attempt,{outcome:noDispatch?'not-dispatched':'uncertain',method:noDispatch?'no-dispatch':'recovery',reason:'restart',...(noDispatch?{}:{errorCode:'CLEANUP_UNCERTAIN'})});
        sessions.add(value.sessionId);
      }
    }
  }
}
