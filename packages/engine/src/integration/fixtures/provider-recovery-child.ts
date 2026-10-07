import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EngineError } from '@moodcode/contracts';
import { createEngine } from '../../engine.js';
import { SqliteStore } from '../../storage/index.js';
import type { ProviderAdapter, ProviderEvent } from '../../ports.js';

// This child owns only its temporary database and synthetic provider iterator.
// The parent stops/kills this process at a real durable observation/COMMIT.
const [directory, phase] = process.argv.slice(2);
if (!directory || !['before-commit','after-commit','attempt-settled'].includes(phase!)) throw new Error('Invalid provider recovery crash phase');
SqliteStore.prototype.getSnapshot=()=>{throw new Error('Provider crash child forbids whole snapshots, including startup');};
const repository=join(directory,'repository');mkdirSync(repository);
let attempted=false,runId='',attemptId='',turnId='';
const provider:ProviderAdapter={id:'provider-recovery-crash',streamTurn(request){
  appendFileSync(join(directory,'provider-calls.log'),'dispatch\n',{mode:0o600});attemptId=request.attemptId!;turnId=request.turnId!;
  let index=0;const iterator:AsyncIterableIterator<ProviderEvent>={ [Symbol.asyncIterator](){return iterator;},async next(){
    if(index++===0)return{done:false,value:{type:'usage',inputTokens:11,outputTokens:3}};
    if(index===2)return{done:false,value:{type:'text.delta',delta:'Synthetic partial public answer before crash.'}};
    throw new EngineError('PROVIDER_TRANSPORT_ERROR','Synthetic remote outcome remains unknown');
  },async return(){return{done:true,value:undefined};}};return iterator;
}};
const options={dbPath:join(directory,'engine.sqlite'),artifactDir:join(directory,'artifacts'),providers:[provider],allowedToolNames:['read_file'],defaults:{providerId:provider.id,modelId:'fixture-model',mode:'plan' as const,limits:{maxContextBytes:262144,maxOutputBytes:32768}}};
let engine=createEngine(options);const now=new Date().toISOString();
engine.store.putWorkspace({id:'workspace',root:repository,gitRoot:repository,branch:null,createdAt:now});engine.store.createSession({id:'session',workspaceId:'workspace',title:'Provider recovery crash',createdAt:now});
engine.store.getSnapshot=()=>{throw new Error('Provider recovery child forbids whole snapshots');};
function stop(request?:unknown){if(attempted)return;attempted=true;process.send?.({phase,runId,attemptId,turnId,request});process.kill(process.pid,'SIGSTOP');}
if(phase==='attempt-settled'){
  const database=(engine.store as unknown as{db:DatabaseSync}).db,exec=database.exec.bind(database);
  database.exec=sql=>{
    const result=exec(sql);
    if(/^\s*COMMIT\s*;?\s*$/iu.test(sql)&&attemptId){
      const attempt=database.prepare('SELECT state FROM provider_attempts WHERE id=?').get(attemptId),turn=database.prepare('SELECT state FROM session_turns WHERE id=?').get(turnId);
      if(attempt?.state==='uncertain'&&['created','streaming'].includes(String(turn?.state)))stop();
    }return result;
  };
}
runId=engine.coordinator.submit({sessionId:'session',requestId:'primary',prompt:'Synthetic provider recovery crash goal.',config:engine.getCapabilities().defaults}).runId;
if((await engine.waitForRun(runId)).error?.code!=='PROVIDER_TRANSPORT_ERROR')throw new Error('Child did not produce an actual uncertain ordinary outcome');
await engine.waitForSession('session');await engine.close();engine=createEngine(options);engine.store.getSnapshot=()=>{throw new Error('Restarted provider child forbids whole snapshots');};
const preview=engine.getProviderRecoveryPreview('session',attemptId);if(preview.status!=='eligible'||!preview.fingerprint)throw new Error(`Restarted provider candidate is not eligible: ${JSON.stringify(preview)}`);
const request={sessionId:'session',attemptId,requestId:'crash-host-decision',fingerprint:preview.fingerprint,acknowledged:true as const};
if(phase==='before-commit'){
  const database=(engine.store as unknown as{db:DatabaseSync}).db,exec=database.exec.bind(database);
  database.exec=sql=>{if(/^\s*COMMIT\s*;?\s*$/iu.test(sql)&&database.isTransaction&&Number(database.prepare('SELECT count(*) AS n FROM provider_recovery_acknowledgments').get()!.n)===1)stop(request);return exec(sql);};
}
await engine.acknowledgeProviderRecovery(request);if(phase==='after-commit')stop(request);
setInterval(()=>engine.store.getSession('session'),1000);
